function parseContract(text:string) {
    const regex = /^([A-Z]+)(\d{2})([A-Z]{3})([A-Z]+)$/;
    const match = text.match(regex);
  
    if (!match) return null;
  
    const [symbol, instrument, yy, month, type] = match;
  
    // Build date string (1st of month)
    const year = 2000 + parseInt(yy, 10);
    const dateStr = `01-${month}-${year}`;
    let date = new Date(dateStr);
  
    // Add 5 hours 30 minutes (IST offset)
    date = new Date(date.getTime() + (5 * 60 + 30) * 60000);
  
    // Format YYYY-MM-DD
    const formatted = date.toISOString().slice(0, 10);
  
    return {
      symbol,
      instrument,
      expiry: formatted,
      type,
    };
  }
  
  // Example usage
//   const input = "DRREDDY25SEPFUT";
//   console.log(parseContract(input)); // [ 'DRREDDY', '25', 'SEP', 'FUT' ]

export {parseContract};
  