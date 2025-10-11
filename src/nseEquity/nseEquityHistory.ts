import axios from "axios";
import { getAccessToken } from "../config/store";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getNseEquityHistory(date: string) {
  const accessToken = getAccessToken();
  try {
    if (!accessToken) {
      throw new Error("Access token not found");
    }
    const response = await axios.get(
      `https://history.truedata.in/getbhavcopystatus?segment=EQ&date=${date}&response=json`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    if (response.data.status === "Invalid segment") {
      await prisma.dates_missed.create({
        data: {
          date: new Date(date),
          day: new Date(date).toLocaleDateString("en-US", { weekday: "long" }),
          segment: "fo",
        },
      });
      console.log("Bhavcopy not found");
      return false;
    } else {
      // Add small delay between status check and actual data fetch
      await delay(1000);
      const bhavcopy = await axios.get(
        `https://history.truedata.in/getbhavcopy?segment=eq&date=${date}&response=json`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      return bhavcopy.data;
    }
  } catch (error) {
    console.error("Error fetching NSE Equity history:", error);
    return false;
  }
}

export { getNseEquityHistory };

// DRREDDY25SEPFUT  ->  DRREDDY 25 SEP FUT
