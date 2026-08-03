"""
Find gaps/missing data in nse_futures and nse_options vs. what symbols_list
says should have been active on each trading day.

For every date that appears in nse_futures or nse_options:
  - "expected" symbol count = rows in symbols_list that were active that day:
      created_at::date <= date AND expiry_date >= date, data_status IS NULL
  - "actual" symbol count   = distinct symbols actually found in
      nse_futures / nse_options for that day
  - gap = expected - actual

Also compares distinct underlying instrument counts (instrument_lists, via the
`underlying` FK on nse_futures/nse_options) the same way.

NOTE on "expected" / created_at: symbols_list.created_at is "when we inserted
the row," not "when NSE actually listed the contract." A chunk of this table
came from historical backfills done long after the fact, so created_at can't
be trusted as an exact listing date for those rows. Two things follow:
  1. A handful of legacy rows have created_at AFTER expiry_date (backfilled
     well after the contract had already expired) -- those rows are excluded
     entirely from "expected" (they can never have been "active" under this
     definition for any date), otherwise they corrupt the count.
  2. For date ranges that were bulk-backfilled on a single day, "expected"
     for OLDER dates in that range will undercount, because created_at sits
     at the backfill date, not the real listing date -- e.g. if 2022-2024
     options were all backfilled on one day in 2025, every one of those rows
     looks "not yet created" for all of 2022-2024. Numbers for recently
     ingested (day-by-day, live-cron) dates are the trustworthy ones; treat
     "expected" for old backfilled ranges as a floor, not exact.
  3. Separately, even where "expected" is accurate: most listed OTM option
     strikes never trade at all on a given day, so OPT gaps will look large
     by default -- that's "no volume that day," not a sync failure. FUT gaps
     are a much cleaner signal since almost every listed future trades daily.

Performance note: this deliberately avoids a SQL join between "every trading
date" and symbols_list (that cross-join made Postgres rescan symbols_list once
per date and hung for minutes against the production DB, starving the
PgBouncer connection pool). Instead it pulls symbols_list once and derives the
day-by-day "how many were active" counts locally via a sweep line.

Usage:
    python scripts/python/find_data_gaps.py                    # full summary table
    python scripts/python/find_data_gaps.py --csv gaps.csv      # also write CSV
    python scripts/python/find_data_gaps.py --min-gap 5         # only show bigger gaps
    python scripts/python/find_data_gaps.py --details 2026-07-15 --segment FUT
        # list the exact symbols missing from nse_futures on that date
"""

import argparse
import csv
import datetime
import os
import sys
from bisect import bisect_right
from urllib.parse import urlparse

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
# nse_options alone is ~35M rows; the full-history GROUP BY over it measured
# ~70s against the production DB. Give it headroom without going unbounded.
STATEMENT_TIMEOUT_MS = 120_000

TRADING_DATES_SQL_TMPL = """
SELECT DISTINCT date FROM market_data.nse_futures {where}
UNION
SELECT DISTINCT date FROM market_data.nse_options {where}
ORDER BY date;
"""
# NSE never trades Sat/Sun; some historical rows carry a mis-dated weekend
# timestamp (a separate backfill-time bug), which would otherwise show up as
# a phantom 100%-gap trading day. Applied as its own WHERE clause per table
# (not folded into {where}) so it always applies regardless of --since.
_WEEKEND_FILTER = "EXTRACT(ISODOW FROM date) < 6"

ACTUAL_COUNTS_SQL_TMPL = """
SELECT date,
       COUNT(DISTINCT symbol)     AS actual_symbols,
       COUNT(DISTINCT underlying) AS actual_instruments
FROM market_data.{table}
{where}
GROUP BY date;
"""

SYMBOL_WINDOWS_SQL = """
SELECT id AS symbol_id, instrument_id, segment, created_at::date AS start_date, expiry_date AS end_date
FROM market_data.symbols_list
WHERE data_status IS NULL
  AND segment IN ('FUT', 'OPT')
  AND created_at IS NOT NULL
  AND expiry_date IS NOT NULL;
"""

DETAILS_SQL = """
SELECT sl.id AS symbol_id, sl.symbol, sl.expiry_date, il.instrument_type, sl.upstox_id
FROM market_data.symbols_list sl
JOIN market_data.instrument_lists il ON il.id = sl.instrument_id
WHERE sl.segment = %(segment)s
  AND sl.data_status IS NULL
  AND sl.expiry_date >= %(date)s
  AND sl.created_at::date <= %(date)s
  AND sl.id NOT IN (
      SELECT DISTINCT symbol FROM market_data.{table} WHERE date = %(date)s
  )
ORDER BY il.instrument_type, sl.symbol;
"""


def get_connection():
    load_dotenv(ENV_PATH)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit(f"DATABASE_URL not found in {ENV_PATH}")

    parsed = urlparse(database_url)
    conn = psycopg2.connect(
        host=parsed.hostname,
        port=parsed.port or 5432,
        user=parsed.username,
        password=parsed.password,
        dbname=parsed.path.lstrip("/"),
    )
    with conn.cursor() as cur:
        cur.execute(f"SET statement_timeout = {STATEMENT_TIMEOUT_MS}")
    return conn


def expected_counts_by_date(symbol_rows, segment: str, trading_dates: list[datetime.date]):
    """
    Sweep-line: for the given segment, compute (expected_symbol_count,
    expected_distinct_instrument_count) as of each date in trading_dates,
    without ever comparing every symbol against every date.

    A row is "active" on [start_date, end_date] (created_at, expiry_date).
    Rows where start_date > end_date (backfilled after their own expiry) have
    an empty/impossible active window and are dropped -- otherwise they'd
    generate an out-of-order (-1) event before its matching (+1), corrupting
    the running totals for every date in between.
    """
    rows = [r for r in symbol_rows if r["segment"] == segment and r["start_date"] <= r["end_date"]]

    # Symbol-count events: +1 when a contract starts, -1 the day after it expires.
    events = []
    for r in rows:
        events.append((r["start_date"], 1))
        events.append((r["end_date"] + datetime.timedelta(days=1), -1))
    events.sort(key=lambda e: e[0])
    event_dates = [e[0] for e in events]

    # Prefix sum of deltas up to (and including) each event date.
    running = 0
    prefix = []
    for _, delta in events:
        running += delta
        prefix.append(running)

    def symbols_active_as_of(d: datetime.date) -> int:
        idx = bisect_right(event_dates, d) - 1
        return prefix[idx] if idx >= 0 else 0

    # Distinct-instrument count needs reference counting per instrument, since
    # the same instrument can have several overlapping contracts.
    instrument_events = []
    for r in rows:
        instrument_events.append((r["start_date"], r["instrument_id"], 1))
        instrument_events.append((r["end_date"] + datetime.timedelta(days=1), r["instrument_id"], -1))
    instrument_events.sort(key=lambda e: e[0])

    active_count = {}  # instrument_id -> current active contract count
    distinct_instruments = 0
    ievent_dates = []
    distinct_prefix = []
    for d, instrument_id, delta in instrument_events:
        before = active_count.get(instrument_id, 0)
        after = before + delta
        active_count[instrument_id] = after
        if before == 0 and after > 0:
            distinct_instruments += 1
        elif before > 0 and after == 0:
            distinct_instruments -= 1
        ievent_dates.append(d)
        distinct_prefix.append(distinct_instruments)

    def instruments_active_as_of(d: datetime.date) -> int:
        idx = bisect_right(ievent_dates, d) - 1
        return distinct_prefix[idx] if idx >= 0 else 0

    return {
        d: (symbols_active_as_of(d), instruments_active_as_of(d))
        for d in trading_dates
    }


def run_summary(conn, min_gap: int, csv_path: str | None, since: str | None):
    conditions = [_WEEKEND_FILTER]
    if since:
        conditions.append("date >= %(since)s")
    where = "WHERE " + " AND ".join(conditions)
    params = {"since": since} if since else None

    with conn.cursor() as cur:
        cur.execute(TRADING_DATES_SQL_TMPL.format(where=where), params)
        trading_dates = [row[0] for row in cur.fetchall()]

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(ACTUAL_COUNTS_SQL_TMPL.format(table="nse_futures", where=where), params)
        actual_futures = {row["date"]: row for row in cur.fetchall()}

        print("Scanning nse_options (~35M rows) — this can take ~60-90s for full history..." if not since else "Scanning nse_options...")
        cur.execute(ACTUAL_COUNTS_SQL_TMPL.format(table="nse_options", where=where), params)
        actual_options = {row["date"]: row for row in cur.fetchall()}

        cur.execute(SYMBOL_WINDOWS_SQL)
        symbol_rows = cur.fetchall()

    expected_fut = expected_counts_by_date(symbol_rows, "FUT", trading_dates)
    expected_opt = expected_counts_by_date(symbol_rows, "OPT", trading_dates)

    rows = []
    for d in trading_dates:
        fut_exp_sym, fut_exp_instr = expected_fut[d]
        opt_exp_sym, opt_exp_instr = expected_opt[d]
        af = actual_futures.get(d, {"actual_symbols": 0, "actual_instruments": 0})
        ao = actual_options.get(d, {"actual_symbols": 0, "actual_instruments": 0})
        rows.append({
            "date": d,
            "fut_expected_symbols": fut_exp_sym,
            "fut_actual_symbols": af["actual_symbols"],
            "fut_symbol_gap": fut_exp_sym - af["actual_symbols"],
            "fut_expected_instruments": fut_exp_instr,
            "fut_actual_instruments": af["actual_instruments"],
            "fut_instrument_gap": fut_exp_instr - af["actual_instruments"],
            "opt_expected_symbols": opt_exp_sym,
            "opt_actual_symbols": ao["actual_symbols"],
            "opt_symbol_gap": opt_exp_sym - ao["actual_symbols"],
            "opt_expected_instruments": opt_exp_instr,
            "opt_actual_instruments": ao["actual_instruments"],
            "opt_instrument_gap": opt_exp_instr - ao["actual_instruments"],
        })

    if csv_path:
        with open(csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else [])
            writer.writeheader()
            writer.writerows(rows)
        print(f"Wrote {len(rows)} rows to {csv_path}\n")

    gap_rows = [
        r for r in rows
        if abs(r["fut_symbol_gap"]) >= min_gap or abs(r["opt_symbol_gap"]) >= min_gap
    ]

    print(f"Trading days checked: {len(rows)}")
    print(f"Days with a symbol-count gap >= {min_gap}: {len(gap_rows)}\n")

    if not gap_rows:
        print("No gaps found.")
        return

    header = (
        f"{'Date':<12} {'FUT exp':>8} {'FUT act':>8} {'FUT gap':>8} "
        f"{'OPT exp':>8} {'OPT act':>8} {'OPT gap':>8} "
        f"{'Instr(F)':>9} {'Instr(O)':>9}"
    )
    print(header)
    print("-" * len(header))
    for r in gap_rows:
        print(
            f"{str(r['date']):<12} "
            f"{r['fut_expected_symbols']:>8} {r['fut_actual_symbols']:>8} {r['fut_symbol_gap']:>8} "
            f"{r['opt_expected_symbols']:>8} {r['opt_actual_symbols']:>8} {r['opt_symbol_gap']:>8} "
            f"{r['fut_instrument_gap']:>9} {r['opt_instrument_gap']:>9}"
        )


def run_details(conn, date: str, segment: str):
    table = "nse_futures" if segment == "FUT" else "nse_options"
    sql = DETAILS_SQL.format(table=table)
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, {"segment": segment, "date": date})
        rows = cur.fetchall()

    print(f"\nSymbols expected active for {segment} on {date} but missing from {table}: {len(rows)}\n")
    if not rows:
        print("None — fully covered.")
        return

    print(f"{'symbol_id':<10} {'instrument_type':<20} {'symbol':<30} {'expiry_date':<12} upstox_id")
    print("-" * 100)
    for r in rows:
        print(
            f"{r['symbol_id']:<10} {r['instrument_type']:<20} {r['symbol']:<30} "
            f"{str(r['expiry_date']):<12} {r['upstox_id'] or ''}"
        )


def main():
    parser = argparse.ArgumentParser(description="Find gaps in nse_futures/nse_options vs. symbols_list")
    parser.add_argument("--csv", help="Write the full per-day summary table to this CSV path")
    parser.add_argument("--min-gap", type=int, default=1, help="Only print days with |gap| >= this (default 1)")
    parser.add_argument("--details", metavar="YYYY-MM-DD", help="List missing symbols for a specific date")
    parser.add_argument("--segment", choices=["FUT", "OPT"], default="FUT", help="Segment for --details (default FUT)")
    parser.add_argument(
        "--since",
        metavar="YYYY-MM-DD",
        help="Only scan trading dates on/after this date (default: full history — "
             "slower, since nse_options alone is ~35M rows)",
    )
    args = parser.parse_args()

    conn = get_connection()
    try:
        if args.details:
            run_details(conn, args.details, args.segment)
        else:
            run_summary(conn, args.min_gap, args.csv, args.since)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
