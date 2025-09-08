function parseContract(symbol: string) {
    // Array of regex patterns to try in order
    const regexPatterns = [
        // Pattern 1: Uppercase instrument with 6-digit strike (most specific first)
        /^([A-Z]+)(\d{2})(\d{2})(\d{2})(\d{6})(CE|PE)$/i,
        // Pattern 2: Uppercase instrument with 5-digit strike
        /^([A-Z]+)(\d{2})(\d{2})(\d{2})(\d{5})(CE|PE)$/i,
        // Pattern 3: Uppercase instrument with variable digit strike
        /^([A-Z]+)(\d{2})(\d{2})(\d{2})(\d+)(CE|PE)$/i,
        // Pattern 4: Variable instrument with decimal strike
        /^(.+?)(\d{2})(\d{2})(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/i,
        // Pattern 5: Fallback for any format
        /^(.+?)(\d{2})(\d{2})(\d{2})(\d+)(CE|PE)$/i
    ];

    let match = null;
    
    // Try each regex pattern until one matches
    for (const regex of regexPatterns) {
        match = symbol.match(regex);
        if (match) {
            break; // Exit loop on first successful match
        }
    }

    // If no pattern matched, return null
    if (!match) return null;

    // Parse the date from the matched groups
    const year = 2000 + parseInt(match[2], 10);
    const month = match[3];
    const day = match[4];
    
    // Create date with proper month indexing (0-based)
    const date = new Date(year, parseInt(month, 10) - 1, parseInt(day, 10));
    
    // Validate the date
    if (isNaN(date.getTime())) {
        console.error(`Invalid date: ${year}-${month}-${day}`);
        return null;
    }
 
    // Format YYYY-MM-DD (avoid timezone issues)
    const formatted = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  
    return {
      symbol,
      instrument: match[1],
      expiry: formatted,
      strike: match[5],
      type: match[6]
    };
  }
  
  // Example usage
//   const input = "NIFTY22063014500PE"; // ABB2209293350CE   M&MFIN220929257.5CE   MRF220929100000CE
//   console.log(parseContract(input)); // [ 'NIFTY22063014500PE', 'NIFTY', '2022-06-30', 'PE' ]
export {parseContract};
  