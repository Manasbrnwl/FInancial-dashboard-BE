/**
 * Returns an array of date strings (YYYY-MM-DD) from the given past date up to today (inclusive).
 *
 * - Accepts a Date instance or a parsable date string.
 * - Throws if the date is invalid or in the future.
 * - Uses local timezone when iterating days.
 */
export function getDatesFromPastToToday(start: Date | string): string[] {
  const startDate = normalizeToLocalDate(start);

  const today = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (startDate.getTime() > todayLocal.getTime()) {
    throw new Error('Start date must be in the past or today');
  }

  const dates: string[] = [];
  const cursor = new Date(startDate);

  while (cursor.getTime() <= todayLocal.getTime()) {
    dates.push(formatYYYYMMDD(cursor));
    // Move to next day in local time
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function normalizeToLocalDate(input: Date | string): Date {
  const d = input instanceof Date ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid start date');
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


