import axios from "axios";
import { config } from "dotenv";
import { fetchInstruments } from "./instrumentsList";
import { insertBSEEqtIntoDataBase } from "./insertBSEEQIntoDatabase";
config();

interface instrumnets_list {
  SECURITY_ID: string;
  SYMBOL_NAME: string;
  INSTRUMENT_TYPE: string;
  EXCHANGE: string;
}

const toDate = new Date();
const fromDate = new Date();
fromDate.setFullYear(toDate.getFullYear() - 7);

async function fetchHistorical(securityId: string) {
  try {
    const clientToken =
      process.env.CLIENT_ACCESS_TOKEN ||
      "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzYwMjgwODM4LCJpYXQiOjE3NTc2ODg4MzgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTA3ODAyMjgzIn0._t73tziMyHB7QXqyjBUV1_d5ic8EKF1CYf-xXTDlEuTwIC9-UtbrqxsaXWp5ZWxYB7ko8Vs-akXJ5VMc3Qoxfw";

    const response = await axios.post(
      "https://api.dhan.co/v2/charts/historical",
      {
        securityId: String(securityId), // must be string
        exchangeSegment: "BSE_EQ",
        instrument: "EQUITY",
        expiryCode: 0,
        oi: false,
        fromDate: "2018-01-01", // YYYY-MM-DD
        toDate: "2025-09-14",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "access-token": clientToken,
        },
      }
    );

    return response.data;
  } catch (err: any) {
    if (err.response) {
      return {
        success: false,
        status: err.response.status,
        error: err.response.data,
      };
    } else if (err.request) {
      return {
        success: false,
        status: null,
        error: err.message,
      };
    } else {
      return {
        success: false,
        status: null,
        error: err.message,
      };
    }
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function getBseEquityHistory() {
  const instruments: instrumnets_list[] = await fetchInstruments();

  for (const instr of instruments) {
    // console.log(instr)
    const data = await fetchHistorical(instr.SECURITY_ID);
    if (data.status !== 400) {
      await insertBSEEqtIntoDataBase(instr, data);
    }else{
        console.log(instr, data)
    }
    await delay(2000);
  }
}

export { getBseEquityHistory };
