import axios from "axios";
import { config } from "dotenv";
config();

async function fetchInstruments() {
  try {
    const response = await axios.get(
      process.env.API_URL_INSTRUMENTS ||
        "https://api.dhan.co/v2/instrument/BSE_EQ",
      {
        headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
      }
    );

    const [headerLine, ...dataLines] = response.data.split("\n");
    const headers = headerLine.split(",");

    const result = dataLines.map((line: any) => {
      const fields = line.split(",");
      return {
        SECURITY_ID: fields[headers.indexOf("SECURITY_ID")],
        SYMBOL_NAME: fields[headers.indexOf("UNDERLYING_SYMBOL")],
        INSTRUMENT_TYPE: fields[headers.indexOf("INSTRUMENT_TYPE")],
        EXCHANGE: fields[headers.indexOf("EXCH_ID")],
      };
    });
    return result;
  } catch (err: any) {
    console.error(
      "Error fetching instruments:",
      err.response?.data || err.message
    );
    return [];
  }
}

export { fetchInstruments };
