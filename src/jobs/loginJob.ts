import axios from 'axios';
import { setAccessToken } from '../config/store';
import cron from 'node-cron';
import qs from 'qs';
import { loadEnv } from '../config/env';
import { insertFutIntoDataBase } from '../nseFutures/insertFutIntoDataBase';
import { insertOptIntoDataBase } from '../nseOptions/insertOptIntoDataBase';
import { insertEqIntoDataBase } from '../nseEquity/insertEqtIntoDatabase';
loadEnv();

// API endpoint for login
const LOGIN_API_URL = process.env.LOGIN_API_URL || 'https://auth.truedata.in/token';

/**
 * Function to fetch access token from the login API
 */
async function fetchAccessToken(): Promise<void> {
  try {
    // Replace with actual login credentials from environment variables
    const credentials = {
      username: process.env.API_USERNAME || 'FYERS2317',
      password: process.env.API_PASSWORD || 'HO2LZYCf',
      grant_type: 'password'
    };

    // console.log('🔑 Fetching access token...');
    
    const response = await axios.post(LOGIN_API_URL, qs.stringify(credentials), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    // console.log('✅ Login response:', response.data);
    
    // Assuming the API returns the token in the response data
    const accessToken = response.data.access_token;
    const date = new Date();
    
    if (accessToken) {
      setAccessToken(accessToken);
      insertFutIntoDataBase(date.toISOString().split("T")[0]);
      insertOptIntoDataBase(date.toISOString().split("T")[0]);
      insertEqIntoDataBase(date.toISOString().split("T")[0]);
      // console.log('✅ Access token updated successfully');
    } else {
      console.error('❌ No access token received from API');
    }
  } catch (error: any) {
      console.error('❌ Failed to fetch access token:', error.message);
  }
}

/**
 * Initialize the login job
 * - Runs immediately when the application starts
 * - Then scheduled to run every morning at 6:00 AM
 */
export function initializeLoginJob(): void {
  // Run immediately when the application starts
  fetchAccessToken();
  
  // Schedule to run every day at 9:00 PM
  cron.schedule('0 21 * * *', fetchAccessToken);
  
  // console.log('⏰ Login job scheduled to run every day at 9:00 PM');
}