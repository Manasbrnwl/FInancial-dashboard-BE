import axios from "axios";
import { getAccessToken } from "../config/store";
import { PrismaClient } from "../generated/prisma";

const prisma = new PrismaClient();

async function getNseOptionsHistory(date: string) {
    const accessToken = getAccessToken();
    try {
        if (!accessToken) {
            throw new Error("Access token not found");
        }
        const response = await axios.get(`https://history.truedata.in/getbhavcopystatus?segment=FO&date=${date}&response=json`, {
            headers: {
                "Authorization": `Bearer ${accessToken}`
            }
        });
        if(response.data.status === "Invalid segment"){
            await prisma.dates_missed.create({
                data: {
                    date: new Date(date),
                    day: new Date(date).toLocaleDateString('en-US', { weekday: 'long' }),
                    segment: "fo"
                }
            });
            console.log("Bhavcopy not found");
            return false
        }else{
            const bhavcopy = await axios.get(`https://history.truedata.in/getbhavcopy?segment=fo&date=${date}&response=json`, {
                headers: {
                    "Authorization": `Bearer ${accessToken}`
                }
            });
            return bhavcopy.data;
        }
    } catch (error) {
        console.error(error);
    }
}

export { getNseOptionsHistory };

// DRREDDY25SEPFUT  ->  DRREDDY 25 SEP FUT