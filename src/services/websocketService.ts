import WebSocket from 'ws';
import { loadEnv } from '../config/env';
import { sendEmailNotification } from '../utils/sendEmail';
import { socketIOService } from './socketioService';

loadEnv();

interface WebSocketConfig {
  url: string;
  username: string;
  password: string;
  reconnectInterval: number;
  maxReconnectAttempts: number;
}

interface MarketData {
  symbol?: string;
  price?: number;
  volume?: number;
  timestamp?: string;
  [key: string]: any;
}

export class TrueDataWebSocketService {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private reconnectAttempts: number = 0;
  private isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private marketHoursCheckTimer: NodeJS.Timeout | null = null;
  private instrumentIdToSymbol: Map<string, string> = new Map(); // Map instrument ID to symbol name

  constructor() {
    this.config = {
      url: `wss://push.truedata.in:8082?user=${process.env.API_USERNAME || 'FYERS2317'}&password=${process.env.API_PASSWORD || 'HO2LZYCf'}`,
      username: process.env.API_USERNAME || 'FYERS2317',
      password: process.env.API_PASSWORD || 'HO2LZYCf',
      reconnectInterval: 5000, // 5 seconds
      maxReconnectAttempts: 10
    };
  }

  /**
   * Check if current time is within market hours (9:00 AM - 3:30 PM IST)
   */
  // private isWithinMarketHours(): boolean {
  //   const now = new Date();

  //   // Convert to IST
  //   const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  //   const hours = istTime.getHours();
  //   const minutes = istTime.getMinutes();
  //   const currentTimeInMinutes = hours * 60 + minutes;

  //   // Market hours: 9:00 AM (540 minutes) to 3:30 PM (930 minutes)
  //   const marketOpenMinutes = 9 * 60; // 9:00 AM = 540 minutes
  //   const marketCloseMinutes = 15 * 60 + 30; // 3:30 PM = 930 minutes

  //   const isWithinHours = currentTimeInMinutes >= marketOpenMinutes && currentTimeInMinutes <= marketCloseMinutes;

  //   // Check if it's a weekday (Monday = 1, Friday = 5)
  //   const dayOfWeek = istTime.getDay();
  //   const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  //   return isWithinHours && isWeekday;
  // }

  /**
   * Start monitoring market hours
   */
  private startMarketHoursMonitoring(): void {
    // Check every minute if we should disconnect due to market hours
    this.marketHoursCheckTimer = setInterval(() => {
      if (this.isConnected) {
        console.log('🕐 Market hours ended. Disconnecting WebSocket...');
        this.stop();
      }
    }, 60000); // Check every minute
  }

  /**
   * Stop market hours monitoring
   */
  private stopMarketHoursMonitoring(): void {
    if (this.marketHoursCheckTimer) {
      clearInterval(this.marketHoursCheckTimer);
      this.marketHoursCheckTimer = null;
    }
  }

  /**
   * Initialize and start the WebSocket connection
   */
  public async start(): Promise<void> {
    try {
      console.log('🌐 Starting TrueData WebSocket service...');

      // Check if within market hours
      // if (!this.isWithinMarketHours()) {
      //   const now = new Date();
      //   const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      //   // console.log('⏰ Outside market hours (9:00 AM - 3:30 PM IST, Monday-Friday)');
      //   console.log(`📅 Current IST time: ${istTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
      //   // console.log('💤 WebSocket connection will not be established');
      //   return;
      // }

      await this.connect();

      // Start monitoring market hours
      this.startMarketHoursMonitoring();

      // Send start notification email
      await this.sendNotificationEmail('started', {});
    } catch (error: any) {
      console.error('❌ Failed to start WebSocket service:', error.message);
      await this.sendNotificationEmail('failed', { errorMessage: error.message });
    }
  }

  /**
   * Establish WebSocket connection
   */
  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log('🔗 Connecting to TrueData WebSocket...');
        console.log(`📡 URL: ${this.config.url}`);

        this.ws = new WebSocket(this.config.url);

        this.ws.on('open', () => {
          console.log('✅ WebSocket connection established');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();

          // Notify frontend clients about backend connection status
          socketIOService.broadcastConnectionStatus('connected');

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`⚠️ WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`);
          this.isConnected = false;
          this.stopHeartbeat();

          // Notify frontend clients about backend disconnection
          socketIOService.broadcastConnectionStatus('disconnected');

          this.handleReconnection();
        });

        this.ws.on('error', (error: Error) => {
          console.error('❌ WebSocket error:', error.message);
          this.isConnected = false;
          this.stopHeartbeat();
          reject(error);
        });

        // Connection timeout
        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000); // 10 seconds timeout

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = data.toString();

      // Skip heartbeat/ping/pong messages
      if (message === 'ping' || message === 'pong' || message === 'heartbeat') {
        return;
      }

      // console.log('📨 Received WebSocket message:', message);

      // Try to parse as JSON
      let parsedData: any;
      try {
        parsedData = JSON.parse(message);
      } catch {
        // If not JSON, treat as plain text
        console.log('📝 Plain text message:', message);
        return;
      }

      // Skip heartbeat messages in JSON format
      if (parsedData.type === 'ping' || parsedData.type === 'pong' || parsedData.type === 'heartbeat') {
        return;
      }

      // Handle subscription response - store instrument ID to symbol mapping
      if (parsedData.success && parsedData.symbollist) {
        this.handleSubscriptionResponse(parsedData.symbollist);
        return;
      }

      // Handle trade updates (complete market data - has OHLCV + bid-ask + more)
      if (parsedData.trade && Array.isArray(parsedData.trade)) {
        this.handleTradeUpdate(parsedData.trade);
        return;
      }

      // Handle bidask updates
      if (parsedData.bidask && Array.isArray(parsedData.bidask)) {
        this.handleBidAskUpdate(parsedData.bidask);
        return;
      }

      // Handle tick updates (full market data)
      if (parsedData.tick && Array.isArray(parsedData.tick)) {
        this.handleTickUpdate(parsedData.tick);
        return;
      }

      // Handle other message types if needed
      // console.log('📝 Unhandled message type:', parsedData);

    } catch (error: any) {
      console.error('❌ Error handling WebSocket message:', error.message);
    }
  }

  /**
   * Handle subscription response and store instrument ID mapping
   */
  private handleSubscriptionResponse(symbolList: any[]): void {
    try {
      symbolList.forEach((symbolData: any[]) => {
        if (Array.isArray(symbolData) && symbolData.length >= 2) {
          const symbolName = symbolData[0]; // First element is symbol name
          const instrumentId = symbolData[1]; // Second element is instrument ID

          this.instrumentIdToSymbol.set(instrumentId, symbolName);
          // console.log(`✅ Mapped instrument ID ${instrumentId} to symbol ${symbolName}`);
        }
      });
    } catch (error: any) {
      console.error('❌ Error handling subscription response:', error.message);
    }
  }

  /**
   * Handle trade update messages (complete market data)
   * trade format: [instrumentId, timestamp, ltp, ltq, atp, totalVolume, open, high, low, prevClose,
   *                change, changePercent, totalValue, unused, totalTrades, bestBid, bidQty, bestAsk, askQty]
   */
  private handleTradeUpdate(tradeData: any[]): void {
    try {
      const instrumentId = tradeData[0];
      const timestamp = tradeData[1];
      const ltp = parseFloat(tradeData[2]);
      const ltq = parseInt(tradeData[3]);
      const atp = parseFloat(tradeData[4]);
      const totalVolume = parseInt(tradeData[5]);
      const open = parseFloat(tradeData[6]);
      const high = parseFloat(tradeData[7]);
      const low = parseFloat(tradeData[8]);
      const prevClose = parseFloat(tradeData[9]);
      const change = parseFloat(tradeData[10]);
      const changePercent = parseFloat(tradeData[11]);
      const totalValue = parseFloat(tradeData[12]);
      const totalTrades = parseInt(tradeData[14]);
      const bestBid = parseFloat(tradeData[15]);
      const bidQty = parseInt(tradeData[16]);
      const bestAsk = parseFloat(tradeData[17]);
      const askQty = parseInt(tradeData[18]);

      // Get symbol name from mapping
      const symbol = this.instrumentIdToSymbol.get(instrumentId);

      if (!symbol) {
        console.warn(`⚠️ Unknown instrument ID: ${instrumentId}`);
        return;
      }

      // Process market data with complete information
      this.processMarketData({
        symbol,
        instrumentId,
        // Price data
        price: ltp,
        ltp,
        ltq,
        atp,
        // OHLC data
        open,
        high,
        low,
        close: prevClose,
        prevClose,
        // Change data
        change,
        changePercent,
        // Volume and value
        volume: totalVolume,
        totalValue,
        totalTrades,
        // Bid-Ask data
        bid: bestBid,
        bidQty,
        ask: bestAsk,
        askQty,
        // Timestamp
        timestamp
      });

    } catch (error: any) {
      console.error('❌ Error handling trade update:', error.message);
    }
  }

  /**
   * Handle bid-ask update messages
   */
  private handleBidAskUpdate(bidaskData: any[]): void {
    try {
      // bidask format: [instrumentId, timestamp, bid, bidQty, ask, askQty]
      const instrumentId = bidaskData[0];
      const timestamp = bidaskData[1];
      const bid = parseFloat(bidaskData[2]);
      const bidQty = parseInt(bidaskData[3]);
      const ask = parseFloat(bidaskData[4]);
      const askQty = parseInt(bidaskData[5]);

      // Get symbol name from mapping
      const symbol = this.instrumentIdToSymbol.get(instrumentId);

      if (!symbol) {
        console.warn(`⚠️ Unknown instrument ID: ${instrumentId}`);
        return;
      }

      // Calculate mid price from bid-ask
      const midPrice = (bid + ask) / 2;

      // Process market data with frontend-compatible format
      this.processMarketData({
        symbol,
        instrumentId,
        // Bid-ask data
        bid,
        bidQty,
        ask,
        askQty,
        // Frontend-compatible fields
        price: midPrice,
        ltp: bid,
        close: midPrice,
        // For bid-ask updates, we don't have OHLCV, so use mid price
        open: midPrice,
        high: ask,
        low: bid,
        volume: bidQty + askQty,
        timestamp
      });

    } catch (error: any) {
      console.error('❌ Error handling bid-ask update:', error.message);
    }
  }

  /**
   * Handle full tick/market data updates
   */
  private handleTickUpdate(tickData: any[]): void {
    try {
      // tick format varies, but typically: [instrumentId, timestamp, ltp, volume, open, high, low, close, ...]
      const instrumentId = tickData[0];
      const timestamp = tickData[1];

      // Get symbol name from mapping
      const symbol = this.instrumentIdToSymbol.get(instrumentId);

      if (!symbol) {
        console.warn(`⚠️ Unknown instrument ID: ${instrumentId}`);
        return;
      }

      // Parse tick data (adjust indices based on TrueData's actual format)
      const ltp = tickData[2] ? parseFloat(tickData[2]) : undefined;
      const volume = tickData[3] ? parseInt(tickData[3]) : undefined;
      const open = tickData[4] ? parseFloat(tickData[4]) : undefined;
      const high = tickData[5] ? parseFloat(tickData[5]) : undefined;
      const low = tickData[6] ? parseFloat(tickData[6]) : undefined;
      const close = tickData[7] ? parseFloat(tickData[7]) : ltp;

      // Process market data
      this.processMarketData({
        symbol,
        instrumentId,
        price: ltp ?? close,
        ltp,
        open,
        high,
        low,
        close,
        volume,
        timestamp
      });

    } catch (error: any) {
      console.error('❌ Error handling tick update:', error.message);
    }
  }

  /**
   * Process incoming market data
   */
  private processMarketData(data: MarketData): void {
    try {
      // Prepare formatted data for frontend
      const formattedData = {
        ...data,
        timestamp: data.timestamp || new Date().toISOString()
      };

      // Broadcast to all connected frontend clients via Socket.io
      socketIOService.broadcastMarketData(formattedData);

      // Log brief summary
      // if (data.bid && data.ask) {
      //   console.log(`💰 ${data.symbol}: Bid ₹${data.bid} | Ask ₹${data.ask} | Mid ₹${data.price?.toFixed(2)} → ${socketIOService.getConnectedClientsCount()} clients`);
      // } else {
      //   console.log(`💰 ${data.symbol}: Price ₹${data.price?.toFixed(2)} | Vol ${data.volume} → ${socketIOService.getConnectedClientsCount()} clients`);
      // }

    } catch (error: any) {
      console.error('❌ Error processing market data:', error.message);
    }
  }

  /**
   * Send subscription message for specific symbols
   */
  public subscribeToSymbols(symbols: string[]): void {
    if (!this.isConnected || !this.ws) {
      console.error('❌ Cannot subscribe: WebSocket not connected');
      return;
    }

    try {
      const subscriptionMessage = {
        method: 'addsymbol',
        symbols: symbols
      };

      this.ws.send(JSON.stringify(subscriptionMessage));
      // console.log('📡 Subscription request sent for symbols:', symbols);
    } catch (error: any) {
      console.error('❌ Error sending subscription:', error.message);
    }
  }

  /**
   * Send unsubscription message for specific symbols
   */
  public unsubscribeFromSymbols(symbols: string[]): void {
    if (!this.isConnected || !this.ws) {
      console.error('❌ Cannot unsubscribe: WebSocket not connected');
      return;
    }

    try {
      const unsubscriptionMessage = {
        method: 'removesymbol',
        symbols: symbols
      };

      this.ws.send(JSON.stringify(unsubscriptionMessage));
      // console.log('📡 Unsubscription request sent for symbols:', symbols);

      // Clean up instrument ID mapping for unsubscribed symbols
      this.instrumentIdToSymbol.forEach((symbolName, instrumentId) => {
        if (symbols.includes(symbolName)) {
          this.instrumentIdToSymbol.delete(instrumentId);
          // console.log(`🗑️ Removed mapping for ${symbolName} (${instrumentId})`);
        }
      });
    } catch (error: any) {
      console.error('❌ Error sending unsubscription:', error.message);
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.ping();
          // console.log('💓 Heartbeat sent');
        } catch (error: any) {
          console.error('❌ Error sending heartbeat:', error.message);
        }
      }
    }, 30000); // Send heartbeat every 30 seconds
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Handle reconnection logic
   */
  private handleReconnection(): void {
    // Check if within market hours before attempting reconnection
    // if (!this.isWithinMarketHours()) {
    //   console.log('⏰ Outside market hours. Skipping reconnection.');
    //   this.stopMarketHoursMonitoring();
    //   return;
    // }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached. Stopping reconnection.');
      this.sendNotificationEmail('failed', {
        errorMessage: `Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`
      });
      return;
    }

    this.reconnectAttempts++;
    console.log(`🔄 Attempting to reconnect... (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    // Notify frontend clients about reconnection attempts
    socketIOService.broadcastConnectionStatus('reconnecting');

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error: any) {
        console.error('❌ Reconnection failed:', error.message);
        this.handleReconnection();
      }
    }, this.config.reconnectInterval);
  }

  /**
   * Send email notification about WebSocket status
   */
  private async sendNotificationEmail(
    status: 'started' | 'connected' | 'disconnected' | 'failed',
    details: { errorMessage?: string; reconnectAttempts?: number }
  ): Promise<void> {
    try {
      const date = new Date();
      const timeString = date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: true,
      });

      // let subject: string;
      // let textContent: string;
      // let htmlContent: string;

      // switch (status) {
      //   case 'started':
      //     subject = '🌐 TrueData WebSocket Service Started';
      //     textContent = `TrueData WebSocket service started at ${timeString}`;
      //     htmlContent = `
      //       <h2>🌐 TrueData WebSocket Service Started</h2>
      //       <p><strong>Time:</strong> ${timeString}</p>
      //       <p><strong>Status:</strong> Service initialization successful</p>
      //       <p>Connecting to real-time market data feed...</p>
      //     `;
      //     break;

      //   case 'connected':
      //     subject = '✅ TrueData WebSocket Connected';
      //     textContent = `WebSocket connection established at ${timeString}`;
      //     htmlContent = `
      //       <h2>✅ TrueData WebSocket Connected</h2>
      //       <p><strong>Connection Time:</strong> ${timeString}</p>
      //       <p><strong>Status:</strong> ✅ Connected</p>
      //       <p>Real-time market data feed is now active.</p>
      //     `;
      //     break;

      //   case 'disconnected':
      //     subject = '⚠️ TrueData WebSocket Disconnected';
      //     textContent = `WebSocket connection lost at ${timeString}. Reconnection attempts: ${details.reconnectAttempts || 0}`;
      //     htmlContent = `
      //       <h2>⚠️ TrueData WebSocket Disconnected</h2>
      //       <p><strong>Disconnection Time:</strong> ${timeString}</p>
      //       <p><strong>Status:</strong> ⚠️ Disconnected</p>
      //       <p><strong>Reconnection Attempts:</strong> ${details.reconnectAttempts || 0}</p>
      //       <p>Attempting to reconnect to market data feed...</p>
      //     `;
      //     break;

      //   case 'failed':
      //     subject = '❌ TrueData WebSocket Service Failed';
      //     textContent = `WebSocket service failed at ${timeString}. Error: ${details.errorMessage}`;
      //     htmlContent = `
      //       <h2>❌ TrueData WebSocket Service Failed</h2>
      //       <p><strong>Failure Time:</strong> ${timeString}</p>
      //       <p><strong>Status:</strong> ❌ Failed</p>
      //       <hr>
      //       <h3>🚨 Error Details:</h3>
      //       <p><strong>Error Message:</strong> ${details.errorMessage || 'Unknown error'}</p>
      //       <p><em>Please check the application logs for detailed information.</em></p>
      //     `;
      //     break;
      // }

      // await sendEmailNotification(
      //   process.env.RECEIVER_EMAIL || 'mystmanas@gmail.com',
      //   subject,
      //   textContent,
      //   htmlContent
      // );

      console.log(`📧 Email notification sent: ${status}`);
    } catch (error: any) {
      console.error(`❌ Failed to send email notification:`, error.message);
    }
  }

  /**
   * Get connection status
   */
  public getStatus(): { isConnected: boolean; reconnectAttempts: number } {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  /**
   * Stop the WebSocket service
   */
  public stop(): void {
    console.log('🛑 Stopping TrueData WebSocket service...');

    this.stopHeartbeat();
    this.stopMarketHoursMonitoring();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    console.log('✅ WebSocket service stopped');
  }
}

// Export singleton instance
export const webSocketService = new TrueDataWebSocketService();