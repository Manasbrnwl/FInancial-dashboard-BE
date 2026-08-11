/**
 * NSE equity/equity-derivatives trading holidays, by year. Source: NSE's
 * annually published holiday circular (cross-checked via cleartax.in for
 * 2026). Sat/Sun are never listed here -- those are handled separately by a
 * day-of-week check, since they never change.
 *
 * dailyOhlcUpstoxJob previously only skipped Sat/Sun, so it ran unconditionally
 * on every weekday holiday and stored whatever Upstox's OHLC endpoint returned
 * for a closed market (stale carried-forward prices with wildly inflated/
 * garbage volume) as if it were a real session. Needs a manual update once a
 * year when NSE publishes the next year's calendar.
 */
const NSE_HOLIDAYS: Record<number, string[]> = {
    2026: [
        "2026-01-15", // Maharashtra municipal elections
        "2026-01-26", // Republic Day
        "2026-03-03", // Holi
        "2026-03-26", // Shri Ram Navami
        "2026-03-31", // Shri Mahavir Jayanti
        "2026-04-03", // Good Friday
        "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
        "2026-05-01", // Maharashtra Day
        "2026-05-28", // Bakri Id
        "2026-06-26", // Muharram
        "2026-09-14", // Ganesh Chaturthi
        "2026-10-02", // Mahatma Gandhi Jayanti
        "2026-10-20", // Dussehra
        "2026-11-10", // Diwali - Balipratipada
        "2026-12-25", // Christmas
    ],
};

const warnedYears = new Set<number>();

/**
 * True if `d` (interpreted in IST) is a known NSE trading holiday. Returns
 * false -- not true -- for years with no entry in NSE_HOLIDAYS, logging a
 * one-time warning instead of silently treating every day that year as a
 * holiday; the Sat/Sun check next to this call still covers weekends
 * regardless of whether the year's holiday list has been filled in.
 */
export function isNseHoliday(d: Date): boolean {
    const istDateStr = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
    const year = Number(istDateStr.slice(0, 4));
    const list = NSE_HOLIDAYS[year];
    if (!list) {
        if (!warnedYears.has(year)) {
            warnedYears.add(year);
            // eslint-disable-next-line no-console
            console.warn(`⚠️ No NSE holiday list configured for ${year} in src/utils/nseHolidays.ts -- only Sat/Sun will be skipped until it's added.`);
        }
        return false;
    }
    return list.includes(istDateStr);
}
