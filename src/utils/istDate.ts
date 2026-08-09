/**
 * Reduces a timestamp to its IST calendar date (midnight UTC of that date),
 * matching the date-only convention used across nse_equity/nse_futures/nse_options.
 * Computed via the IST timezone explicitly rather than server-local time, since
 * the container's OS timezone isn't guaranteed to be Asia/Kolkata.
 *
 * Passing a raw candle timestamp straight into `new Date(...)` and letting the
 * DB driver derive UTC date components from it can shift the stored date by a
 * day (e.g. midnight IST is 18:30 UTC the *previous* day) -- this is what
 * produced ~67k phantom Saturday/Sunday rows in nse_equity (fixed in
 * dailyOhlcUpstoxJob, commit 8289144) and the same pattern later recurred in
 * fillGapsByDate.ts. Always run a candle's own timestamp through this before
 * storing it as a `date` column.
 */
export function toDateOnly(d: Date): Date {
  const istDateStr = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  return new Date(`${istDateStr}T00:00:00.000Z`);
}
