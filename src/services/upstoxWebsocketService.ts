import WebSocket from 'ws';
import axios from 'axios';
import * as protobuf from 'protobufjs';
import path from 'path';
import { loadEnv } from '../config/env';
import { sendEmailNotification } from '../utils/sendEmail';
import { socketIOService } from './socketioService';
import { upstoxAuthService } from './upstoxAuthService';
import { UPSTOX_CONFIG } from '../config/upstoxConfig';

loadEnv();

interface WebSocketConfig {
    reconnectInterval: number;
    maxReconnectAttempts: number;
}

interface MarketData {
    symbol?: string;
    instrumentKey?: string;
    price?: number;
    ltp?: number;
    ltq?: number;
    volume?: number;
    oi?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    bid?: number;
    bidQty?: number;
    ask?: number;
    askQty?: number;
    change?: number;
    changePercent?: number;
    timestamp?: string;
    [key: string]: any;
}

export class UpstoxWebSocketService {
    private ws: WebSocket | null = null;
    private config: WebSocketConfig;
    private reconnectAttempts: number = 0;
    private isConnected: boolean = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private marketHoursCheckTimer: NodeJS.Timeout | null = null;
    private marketOpenTimer: NodeJS.Timeout | null = null;
    private subscribedInstruments: Set<string> = new Set();
    private protoRoot: protobuf.Root | null = null;
    private FeedResponseType: protobuf.Type | null = null;

    constructor() {
        this.config = {
            reconnectInterval: 5000, // 5 seconds
            maxReconnectAttempts: 10
        };
    }

    /**
     * Load and compile the protobuf schema
     */
    private async loadProtoSchema(): Promise<void> {
        try {
            const protoPath = path.join(__dirname, '../proto/marketDataFeed.proto');
            this.protoRoot = await protobuf.load(protoPath);
            this.FeedResponseType = this.protoRoot.lookupType('upstox.market_data.FeedResponse');
            console.log('✅ Protobuf schema loaded successfully');
        } catch (error: any) {
            console.error('❌ Failed to load protobuf schema:', error.message);
            throw error;
        }
    }

    /**
     * Check if current time is within market hours (9:00 AM - 3:30 PM IST)
     */
    private isWithinMarketHours(): boolean {
        const istTime = this.getISTNow();
        const hours = istTime.getHours();
        const minutes = istTime.getMinutes();
        const currentTimeInMinutes = hours * 60 + minutes;

        // Market hours: 9:00 AM (540 minutes) to 3:30 PM (930 minutes)
        const marketOpenMinutes = 9 * 60; // 9:00 AM = 540 minutes
        const marketCloseMinutes = 15 * 60 + 30; // 3:30 PM = 930 minutes

        const isWithinHours = currentTimeInMinutes >= marketOpenMinutes && currentTimeInMinutes <= marketCloseMinutes;

        // Check if it's a weekday (Monday = 1, Friday = 5)
        const dayOfWeek = istTime.getDay();
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

        return isWithinHours && isWeekday;
    }

    /**
     * Get the current time in IST
     */
    private getISTNow(): Date {
        const now = new Date();
        return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    }

    /**
     * Clear scheduled market open timer
     */
    private clearMarketOpenTimer(): void {
        if (this.marketOpenTimer) {
            clearTimeout(this.marketOpenTimer);
            this.marketOpenTimer = null;
        }
    }

    /**
     * Schedule the next attempt to start the WebSocket service at market open
     */
    private scheduleNextMarketOpen(): void {
        const istNow = this.getISTNow();
        const nextOpen = new Date(istNow);
        nextOpen.setHours(9, 0, 0, 0);

        // If we're past today's open time or it's a weekend, move to the next weekday
        while (nextOpen <= istNow || nextOpen.getDay() === 0 || nextOpen.getDay() === 6) {
            nextOpen.setDate(nextOpen.getDate() + 1);
            nextOpen.setHours(9, 0, 0, 0);
        }

        const delay = nextOpen.getTime() - istNow.getTime();
        this.clearMarketOpenTimer();

        this.marketOpenTimer = setTimeout(() => {
            console.log(`Starting Upstox WebSocket service at scheduled market open: ${nextOpen.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`);
            this.start();
        }, delay);

        console.log(`Next WebSocket start scheduled for ${nextOpen.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`);
    }

    /**
     * Start monitoring market hours
     */
    private startMarketHoursMonitoring(): void {
        // Check every minute if we should disconnect due to market hours
        this.marketHoursCheckTimer = setInterval(() => {
            if (this.isConnected && !this.isWithinMarketHours()) {
                console.log('🕐 Market hours ended. Disconnecting Upstox WebSocket...');
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
     * Get authorized WebSocket URL from Upstox API
     */
    private async getAuthorizedWebSocketUrl(): Promise<string> {
        try {
            const accessToken = await upstoxAuthService.getAccessToken();
            if (!accessToken) {
                throw new Error('No Upstox access token available');
            }

            const response = await axios.get(
                `${UPSTOX_CONFIG.BASE_URL}/feed/market-data-feed/authorize`,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        Accept: 'application/json',
                    },
                }
            );

            if (response.data.status === 'success' && response.data.data?.authorizedRedirectUri) {
                console.log('✅ Got authorized WebSocket URL from Upstox');
                return response.data.data.authorizedRedirectUri;
            }

            throw new Error('Failed to get authorized WebSocket URL');
        } catch (error: any) {
            console.error('❌ Failed to get Upstox WebSocket URL:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Initialize and start the WebSocket connection
     */
    public async start(): Promise<void> {
        try {
            this.clearMarketOpenTimer();

            if (this.isConnected) {
                return;
            }

            if (!this.isWithinMarketHours()) {
                const istTime = this.getISTNow();
                console.log(`📅 Current IST time: ${istTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
                this.scheduleNextMarketOpen();
                return;
            }

            // Load protobuf schema
            await this.loadProtoSchema();

            await this.connect();
            this.startMarketHoursMonitoring();
            await this.sendNotificationEmail('started', {});
        } catch (error: any) {
            console.error('❌ Failed to start Upstox WebSocket service:', error.message);
            await this.sendNotificationEmail('failed', { errorMessage: error.message });
        }
    }

    /**
     * Establish WebSocket connection
     */
    private async connect(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                // Get authorized WebSocket URL
                const wsUrl = await this.getAuthorizedWebSocketUrl();
                console.log('🔗 Connecting to Upstox WebSocket...');

                this.ws = new WebSocket(wsUrl, {
                    headers: {
                        'Accept-Encoding': 'gzip, deflate, br'
                    }
                });

                (this.ws as any).binaryType = 'arraybuffer';

                this.ws.on('open', () => {
                    console.log('✅ Upstox WebSocket connection established');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    this.clearMarketOpenTimer();

                    // Notify frontend clients about backend connection status
                    socketIOService.broadcastConnectionStatus('connected');

                    // Re-subscribe to previously subscribed instruments
                    if (this.subscribedInstruments.size > 0) {
                        this.subscribeToSymbols(Array.from(this.subscribedInstruments));
                    }

                    resolve();
                });

                this.ws.on('message', (data: Buffer | ArrayBuffer) => {
                    this.handleMessage(data);
                });

                this.ws.on('close', (code: number, reason: Buffer) => {
                    console.log(`⚠️ Upstox WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`);
                    this.isConnected = false;
                    this.stopHeartbeat();

                    // Notify frontend clients about backend disconnection
                    socketIOService.broadcastConnectionStatus('disconnected');

                    this.handleReconnection();
                });

                this.ws.on('error', (error: Error) => {
                    console.error('❌ Upstox WebSocket error:', error.message);
                    this.isConnected = false;
                    this.stopHeartbeat();
                    reject(error);
                });

                // Connection timeout
                setTimeout(() => {
                    if (!this.isConnected) {
                        reject(new Error('WebSocket connection timeout'));
                    }
                }, 15000); // 15 seconds timeout

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle incoming WebSocket messages (binary protobuf)
     */
    private handleMessage(data: Buffer | ArrayBuffer): void {
        try {
            if (!this.FeedResponseType) {
                console.error('❌ Protobuf schema not loaded');
                return;
            }

            // Convert data to Uint8Array
            const uint8Data = data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.length);

            // Decode protobuf message
            const decoded = this.FeedResponseType.decode(uint8Data) as any;
            const feedData = this.FeedResponseType.toObject(decoded, {
                longs: Number,
                enums: String,
                bytes: String,
            });

            // Process each feed
            if (feedData.feeds && Array.isArray(feedData.feeds)) {
                for (const feed of feedData.feeds) {
                    this.processFeed(feed);
                }
            }

        } catch (error: any) {
            console.error('❌ Error handling Upstox WebSocket message:', error.message);
        }
    }

    /**
     * Process individual feed data
     */
    private processFeed(feed: any): void {
        try {
            // Handle Full Feed
            if (feed.ff) {
                const fullFeed = feed.ff;

                // Market Full Feed
                if (fullFeed.marketFF) {
                    const mff = fullFeed.marketFF;
                    this.processMarketData({
                        instrumentKey: mff.instrument_key,
                        symbol: this.extractSymbolFromKey(mff.instrument_key),
                        ltp: mff.ltpc?.ltp,
                        price: mff.ltpc?.ltp,
                        ltq: mff.ltpc?.ltq,
                        close: mff.ltpc?.cp,
                        volume: mff.quote?.volume,
                        oi: mff.quote?.oi,
                        bid: mff.quote?.bids?.[0]?.bidP,
                        bidQty: mff.quote?.bids?.[0]?.bidQ,
                        ask: mff.quote?.asks?.[0]?.askP,
                        askQty: mff.quote?.asks?.[0]?.askQ,
                        open: mff.ohlc?.open,
                        high: mff.ohlc?.high,
                        low: mff.ohlc?.low,
                        timestamp: mff.last_trade_time ? new Date(mff.last_trade_time).toISOString() : new Date().toISOString()
                    });
                }

                // Index Full Feed
                if (fullFeed.indexFF) {
                    const iff = fullFeed.indexFF;
                    this.processMarketData({
                        instrumentKey: iff.instrument_key,
                        symbol: this.extractSymbolFromKey(iff.instrument_key),
                        ltp: iff.ltpc?.ltp,
                        price: iff.ltpc?.ltp,
                        ltq: iff.ltpc?.ltq,
                        close: iff.ltpc?.cp,
                        timestamp: iff.last_trade_time ? new Date(iff.last_trade_time).toISOString() : new Date().toISOString()
                    });
                }
            }

            // Handle LTPC only updates
            if (feed.ltpc && !feed.ff) {
                this.processMarketData({
                    ltp: feed.ltpc.ltp,
                    price: feed.ltpc.ltp,
                    ltq: feed.ltpc.ltq,
                    close: feed.ltpc.cp,
                    timestamp: feed.ltpc.ltt ? new Date(feed.ltpc.ltt).toISOString() : new Date().toISOString()
                });
            }

        } catch (error: any) {
            console.error('❌ Error processing feed:', error.message);
        }
    }

    /**
     * Extract symbol name from instrument key (e.g., "NSE_EQ|INE848E01016" -> "INE848E01016")
     */
    private extractSymbolFromKey(instrumentKey: string): string {
        if (!instrumentKey) return '';
        const parts = instrumentKey.split('|');
        return parts.length > 1 ? parts[1] : instrumentKey;
    }

    /**
     * Process incoming market data
     */
    private processMarketData(data: MarketData): void {
        try {
            // Calculate change if we have close price
            if (data.ltp && data.close) {
                data.change = data.ltp - data.close;
                data.changePercent = data.close > 0 ? (data.change / data.close) * 100 : 0;
            }

            // Prepare formatted data for frontend
            const formattedData = {
                ...data,
                timestamp: data.timestamp || new Date().toISOString()
            };

            // Broadcast to all connected frontend clients via Socket.io
            socketIOService.broadcastMarketData(formattedData);

        } catch (error: any) {
            console.error('❌ Error processing market data:', error.message);
        }
    }

    /**
     * Generate unique GUID for subscription messages
     */
    private generateGuid(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Send subscription message for specific symbols (instrument keys)
     */
    public subscribeToSymbols(instrumentKeys: string[]): void {
        if (!this.isConnected || !this.ws) {
            console.error('❌ Cannot subscribe: Upstox WebSocket not connected');
            return;
        }

        try {
            const subscriptionMessage = {
                guid: this.generateGuid(),
                method: 'sub',
                data: {
                    mode: 'full', // or 'ltpc' for lite updates
                    instrumentKeys: instrumentKeys
                }
            };

            this.ws.send(JSON.stringify(subscriptionMessage));

            // Track subscribed instruments
            instrumentKeys.forEach(key => this.subscribedInstruments.add(key));

            console.log(`📡 Subscription request sent for ${instrumentKeys.length} instruments`);
        } catch (error: any) {
            console.error('❌ Error sending subscription:', error.message);
        }
    }

    /**
     * Send unsubscription message for specific symbols
     */
    public unsubscribeFromSymbols(instrumentKeys: string[]): void {
        if (!this.isConnected || !this.ws) {
            console.error('❌ Cannot unsubscribe: Upstox WebSocket not connected');
            return;
        }

        try {
            const unsubscriptionMessage = {
                guid: this.generateGuid(),
                method: 'unsub',
                data: {
                    mode: 'full',
                    instrumentKeys: instrumentKeys
                }
            };

            this.ws.send(JSON.stringify(unsubscriptionMessage));

            // Remove from tracked instruments
            instrumentKeys.forEach(key => this.subscribedInstruments.delete(key));

            console.log(`📡 Unsubscription request sent for ${instrumentKeys.length} instruments`);
        } catch (error: any) {
            console.error('❌ Error sending unsubscription:', error.message);
        }
    }

    /**
     * Change subscription mode (full, ltpc)
     */
    public changeMode(mode: 'full' | 'ltpc'): void {
        if (!this.isConnected || !this.ws) {
            console.error('❌ Cannot change mode: Upstox WebSocket not connected');
            return;
        }

        try {
            const changeRequest = {
                guid: this.generateGuid(),
                method: 'change_mode',
                data: {
                    mode: mode,
                    instrumentKeys: Array.from(this.subscribedInstruments)
                }
            };

            this.ws.send(JSON.stringify(changeRequest));
            console.log(`📡 Mode change request sent: ${mode}`);
        } catch (error: any) {
            console.error('❌ Error changing mode:', error.message);
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
        if (!this.isWithinMarketHours()) {
            console.log('⏰ Outside market hours. Skipping reconnection.');
            this.stopMarketHoursMonitoring();
            return;
        }

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

            // Email notifications are commented out to avoid spam
            console.log(`📧 Upstox WebSocket notification: ${status} at ${timeString}`);
        } catch (error: any) {
            console.error(`❌ Failed to send email notification:`, error.message);
        }
    }

    /**
     * Get connection status
     */
    public getStatus(): { isConnected: boolean; reconnectAttempts: number; subscribedCount: number } {
        return {
            isConnected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            subscribedCount: this.subscribedInstruments.size
        };
    }

    /**
     * Stop the WebSocket service
     */
    public stop(): void {
        console.log('🛑 Stopping Upstox WebSocket service...');

        this.stopHeartbeat();
        this.stopMarketHoursMonitoring();
        this.clearMarketOpenTimer();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.isConnected = false;
        console.log('✅ Upstox WebSocket service stopped');

        if (!this.isWithinMarketHours()) {
            this.scheduleNextMarketOpen();
        }
    }
}

// Export singleton instance
export const upstoxWebSocketService = new UpstoxWebSocketService();
