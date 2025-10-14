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
   * Initialize and start the WebSocket connection
   */
  public async start(): Promise<void> {
    try {
      console.log('🌐 Starting TrueData WebSocket service...');
      await this.connect();

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
      console.log('📨 Received WebSocket message:', message);

      // Try to parse as JSON
      let parsedData: MarketData;
      try {
        parsedData = JSON.parse(message);
      } catch {
        // If not JSON, treat as plain text
        console.log('📝 Plain text message:', message);
        return;
      }

      // Process market data
      this.processMarketData(parsedData);

    } catch (error: any) {
      console.error('❌ Error handling WebSocket message:', error.message);
    }
  }

  /**
   * Process incoming market data
   */
  private processMarketData(data: MarketData): void {
    try {
      console.log('📊 Processing market data:', {
        symbol: data.symbol,
        price: data.price,
        volume: data.volume,
        timestamp: data.timestamp || new Date().toISOString()
      });

      // Broadcast to all connected frontend clients via Socket.io
      socketIOService.broadcastMarketData({
        ...data,
        timestamp: data.timestamp || new Date().toISOString()
      });

      // Example: Log significant price movements
      if (data.price && data.symbol) {
        console.log(`💰 ${data.symbol}: ₹${data.price} → Broadcasted to ${socketIOService.getConnectedClientsCount()} clients`);
      }

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
        action: 'subscribe',
        symbols: symbols
      };

      this.ws.send(JSON.stringify(subscriptionMessage));
      console.log('📡 Subscription request sent for symbols:', symbols);
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
        action: 'unsubscribe',
        symbols: symbols
      };

      this.ws.send(JSON.stringify(unsubscriptionMessage));
      console.log('📡 Unsubscription request sent for symbols:', symbols);
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
          console.log('💓 Heartbeat sent');
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

      let subject: string;
      let textContent: string;
      let htmlContent: string;

      switch (status) {
        case 'started':
          subject = '🌐 TrueData WebSocket Service Started';
          textContent = `TrueData WebSocket service started at ${timeString}`;
          htmlContent = `
            <h2>🌐 TrueData WebSocket Service Started</h2>
            <p><strong>Time:</strong> ${timeString}</p>
            <p><strong>Status:</strong> Service initialization successful</p>
            <p>Connecting to real-time market data feed...</p>
          `;
          break;

        case 'connected':
          subject = '✅ TrueData WebSocket Connected';
          textContent = `WebSocket connection established at ${timeString}`;
          htmlContent = `
            <h2>✅ TrueData WebSocket Connected</h2>
            <p><strong>Connection Time:</strong> ${timeString}</p>
            <p><strong>Status:</strong> ✅ Connected</p>
            <p>Real-time market data feed is now active.</p>
          `;
          break;

        case 'disconnected':
          subject = '⚠️ TrueData WebSocket Disconnected';
          textContent = `WebSocket connection lost at ${timeString}. Reconnection attempts: ${details.reconnectAttempts || 0}`;
          htmlContent = `
            <h2>⚠️ TrueData WebSocket Disconnected</h2>
            <p><strong>Disconnection Time:</strong> ${timeString}</p>
            <p><strong>Status:</strong> ⚠️ Disconnected</p>
            <p><strong>Reconnection Attempts:</strong> ${details.reconnectAttempts || 0}</p>
            <p>Attempting to reconnect to market data feed...</p>
          `;
          break;

        case 'failed':
          subject = '❌ TrueData WebSocket Service Failed';
          textContent = `WebSocket service failed at ${timeString}. Error: ${details.errorMessage}`;
          htmlContent = `
            <h2>❌ TrueData WebSocket Service Failed</h2>
            <p><strong>Failure Time:</strong> ${timeString}</p>
            <p><strong>Status:</strong> ❌ Failed</p>
            <hr>
            <h3>🚨 Error Details:</h3>
            <p><strong>Error Message:</strong> ${details.errorMessage || 'Unknown error'}</p>
            <p><em>Please check the application logs for detailed information.</em></p>
          `;
          break;
      }

      await sendEmailNotification(
        process.env.RECEIVER_EMAIL || 'mystmanas@gmail.com',
        subject,
        textContent,
        htmlContent
      );

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