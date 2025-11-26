function getLastTuesday(year:number , month: number) {
    if (month < 1 || month > 12) {
      throw new Error("Provide a valid year and a 1-based month (1–12)."); // [7]
    }
  
    // Last day of the target month: day 0 of next month is last day of current
    const lastDay = new Date(year, month, 0); // e.g., month=2 -> last day of Feb [4][13]
  
    // Thursday is 4 (Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6) [7]
    const TUESDAY = 2;
  
    // Distance to back up from lastDay to the previous Thursday (possibly 0 if already Thursday)
    const back = (lastDay.getDay() - TUESDAY + 7) % 7; // wrap within [0..6] [7]
  
    // Set to last Thursday
    lastDay.setDate(lastDay.getDate() - back); // [7]
    return lastDay.toISOString().split("T")[0];
  }

function parseContract(text:string) {
    const regex = /^([A-Z]+)(\d{2})([A-Z]{3})([A-Z]+)$/;
    const match = text.match(regex);
  
    if (!match) return null;
  
    const [symbol, instrument, yy, month, type] = match;
  
    // Build date string (1st of month)
    const year = 2000 + parseInt(yy, 10);
      // Convert month string (e.g. "SEP") → month number (1–12)
    const monthNames = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const monthNumber = monthNames.indexOf(month) + 1;
    if (monthNumber === 0) throw new Error(`Invalid month: ${month}`);
  
    // Add 5 hours 30 minutes (IST offset)
    const dateStr = getLastTuesday(year, monthNumber);
    let date = new Date(dateStr);

    date = new Date(date.getTime() + (5 * 60 + 30) * 60000);
  
    // Format YYYY-MM-DD
    const formatted = date.toISOString().slice(0, 10);
    const monthName = date.toLocaleString("en-US", { month: "long" });
  
    return {
      symbol,
      instrument,
      expiry: formatted,
      expiryMonthName: monthName,
      type,
    };
  }
  
//   Example usage
//   const input = "DRREDDY25SEPFUT";
//   console.log(parseContract(input)); // [ 'DRREDDY25SEPFUT', 'DRREDDY', '2025-SEPT-29', 'FUT' ]

export {parseContract};
  
