import { ApiClient, MarketDataStreamerV3 } from 'upstox-js-sdk';
import { loadEnv } from '../config/env';
import { socketIOService } from './socketioService';
import { upstoxAuthService } from './upstoxAuthService';

loadEnv();

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
    private streamer: MarketDataStreamerV3 | null = null;
    private isConnected: boolean = false;
    private marketHoursCheckTimer: NodeJS.Timeout | null = null;
    private marketOpenTimer: NodeJS.Timeout | null = null;
    private subscribedInstruments: Set<string> = new Set();
    private reconnectAttempts: number = 0;

    constructor() {
        // Initialize streamer with empty keys initially
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

        const isWithinHours = true // currentTimeInMinutes >= marketOpenMinutes && currentTimeInMinutes <= marketCloseMinutes;

        // Check if it's a weekday (Monday = 1, Friday = 5)
        const dayOfWeek = istTime.getDay();
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

        // For development/testing, you might want to bypass this check
        // return true; 
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
        if (this.marketHoursCheckTimer) clearInterval(this.marketHoursCheckTimer);

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
     * Initialize and start the WebSocket connection
     */
    public async start(): Promise<void> {
        try {
            this.clearMarketOpenTimer();

            if (this.isConnected) {
                console.log('✅ Upstox WebSocket service is already running');
                return;
            }

            if (!this.isWithinMarketHours()) {
                const istTime = this.getISTNow();
                console.log(`📅 Current IST time: ${istTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
                this.scheduleNextMarketOpen();
                return;
            }

            // Get access token
            const token = await upstoxAuthService.getAccessToken();
            if (!token) {
                console.error("❌ No Upstox Access Token available. Cannot start WebSocket.");
                return;
            }

            // Set the token in ApiClient instance
            const apiClient = ApiClient.instance;
            apiClient.authentications['OAUTH2'].accessToken = token;

            console.log('🔗 Initializing Upstox MarketDataStreamer...');

            // Initialize Streamer (re-create if needed to ensure fresh state/token usage if SDK reads instance on init)
            // Note: MarketDataStreamerV3 constructor takes instrumentKeys and mode.
            // We can pass empty keys and verify if we can subscribe later.
            // Based on SDK: constructor(instrumentKeys = [], mode = "ltpc")
            this.streamer = new MarketDataStreamerV3(Array.from(this.subscribedInstruments), "full");

            // Setup Event Listeners
            this.streamer.on("open", () => {
                console.log('✅ Upstox WebSocket connection established');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                socketIOService.broadcastConnectionStatus('connected');

                // Note: MarketDataStreamerV3 handles auto-subscription of keys passed in constructor
                // or added via subscribe().
            });

            this.streamer.on("close", () => {
                console.log('⚠️ Upstox WebSocket connection closed');
                this.isConnected = false;
                socketIOService.broadcastConnectionStatus('disconnected');
            });

            this.streamer.on("error", (error: any) => {
                console.error('❌ Upstox WebSocket error:', error);

                // If error is related to authentication, we might want to refresh token and restart?
                // The SDK's auto-reconnect might try again.
            });

            this.streamer.on("message", (data: any) => {
                this.handleMessage(data);
            });

            this.streamer.on("reconnecting", (msg: string) => {
                console.log(`🔄 Upstox WebSocket Reconnecting: ${msg}`);
                this.reconnectAttempts++;
                socketIOService.broadcastConnectionStatus('reconnecting');
            });

            this.streamer.on("autoReconnectStopped", (msg: string) => {
                console.log(`🛑 Upstox WebSocket Auto Reconnect Stopped: ${msg}`);
            });

            // Enable Auto Reconnect
            this.streamer.autoReconnect(true, 5, 20); // enable, interval(sec), retryCount

            // Connect
            await this.streamer.connect();

            this.startMarketHoursMonitoring();

        } catch (error: any) {
            console.error('❌ Failed to start Upstox WebSocket service:', error.message);
        }
    }

    /**
     * Handle incoming WebSocket messages (JSON string from SDK)
     */
    private handleMessage(data: string): void {
        try {
            const feedData = JSON.parse(data);

            // The SDK returns decoded Protobuf data as JSON object.
            // Support 'feeds' structure.

            if (feedData.feeds && typeof feedData.feeds === 'object') {
                const feedKeys = Object.keys(feedData.feeds);

                for (const instrumentKey of feedKeys) {
                    const feed = feedData.feeds[instrumentKey];
                    if (feed) {
                        this.processFeed(feed, instrumentKey);
                    }
                }
            } else {
                // Initial feed or other messages
                if (feedData.type === 'initial_feed') {
                    console.log('🆕 Initial feed received (subscription confirmed)');
                }
            }
        } catch (error: any) {
            console.error('❌ Error processing message:', error.message);
        }
    }

    /**
     * Process individual feed data
     */
    private processFeed(feed: any, instrumentKey: string): void {
        try {
            // Handle Full Feed
            if (feed.fullFeed) {
                const fullFeed = feed.fullFeed;

                // Market Full Feed
                if (fullFeed.marketFF) {
                    const mff = fullFeed.marketFF;
                    const ohlcData = mff.marketOHLC?.ohlc?.[0];
                    const bidAsk = mff.marketLevel?.bidAskQuote || [];

                    this.processMarketData({
                        instrumentKey: instrumentKey,
                        symbol: this.extractSymbolFromKey(instrumentKey),
                        ltp: mff.ltpc?.ltp,
                        price: mff.ltpc?.ltp,
                        ltq: mff.ltpc?.ltq,
                        close: mff.ltpc?.cp,
                        volume: mff.vtt, // volume traded today
                        oi: mff.oi,
                        bid: bidAsk[0]?.bidP,
                        bidQty: bidAsk[0]?.bidQ,
                        ask: bidAsk[0]?.askP,
                        askQty: bidAsk[0]?.askQ,
                        open: ohlcData?.open,
                        high: ohlcData?.high,
                        low: ohlcData?.low,
                        // atp: mff.atp, // Not strictly in MarketData interface but useful
                        timestamp: mff.ltpc?.ltt ? new Date(Number(mff.ltpc.ltt)).toISOString() : new Date().toISOString()
                    });
                }
                // Index Full Feed
                else if (fullFeed.indexFF) {
                    const iff = fullFeed.indexFF;
                    const ohlcData = iff.marketOHLC?.ohlc?.[0];

                    this.processMarketData({
                        instrumentKey: instrumentKey,
                        symbol: this.extractSymbolFromKey(instrumentKey),
                        ltp: iff.ltpc?.ltp,
                        price: iff.ltpc?.ltp,
                        ltq: iff.ltpc?.ltq,
                        close: iff.ltpc?.cp,
                        open: ohlcData?.open,
                        high: ohlcData?.high,
                        low: ohlcData?.low,
                        timestamp: iff.ltpc?.ltt ? new Date(Number(iff.ltpc.ltt)).toISOString() : new Date().toISOString()
                    });
                }
            }
            // Handle LTPC only updates (if mode is ltpc)
            else if (feed.ltpc) {
                this.processMarketData({
                    instrumentKey: instrumentKey,
                    symbol: this.extractSymbolFromKey(instrumentKey),
                    ltp: feed.ltpc.ltp,
                    price: feed.ltpc.ltp,
                    ltq: feed.ltpc.ltq,
                    close: feed.ltpc.cp,
                    timestamp: feed.ltpc.ltt ? new Date(Number(feed.ltpc.ltt)).toISOString() : new Date().toISOString()
                });
            }
            // Handle Option Greeks
            else if (feed.firstLevelWithGreeks) {
                const flwg = feed.firstLevelWithGreeks;
                this.processMarketData({
                    instrumentKey: instrumentKey,
                    symbol: this.extractSymbolFromKey(instrumentKey),
                    ltp: flwg.ltpc?.ltp,
                    price: flwg.ltpc?.ltp,
                    ltq: flwg.ltpc?.ltq,
                    close: flwg.ltpc?.cp,
                    volume: flwg.vtt,
                    oi: flwg.oi,
                    bid: flwg.firstDepth?.bidP,
                    bidQty: flwg.firstDepth?.bidQ,
                    ask: flwg.firstDepth?.askP,
                    askQty: flwg.firstDepth?.askQ,
                    // delta: flwg.optionGreeks?.delta, // can add if MarketData interface updated
                    // theta: flwg.optionGreeks?.theta,
                    // gamma: flwg.optionGreeks?.gamma,
                    // vega: flwg.optionGreeks?.vega,
                    // iv: flwg.iv,
                    timestamp: flwg.ltpc?.ltt ? new Date(Number(flwg.ltpc.ltt)).toISOString() : new Date().toISOString()
                });
            }

        } catch (error: any) {
            console.error('❌ Error processing feed:', error.message);
        }
    }

    private extractSymbolFromKey(instrumentKey: string): string {
        if (!instrumentKey) return '';
        const parts = instrumentKey.split('|');
        return parts.length > 1 ? parts[1] : instrumentKey;
    }

    private processMarketData(data: MarketData): void {
        try {
            // Filter only required fields: BID, ASK, BIDQTY, ASKQTY, LTP, VOLUME and TIMESTAMP
            const formattedData = {
                symbol: data.instrumentKey || data.symbol,
                ltp: data.ltp,
                volume: data.volume,
                bid: data.bid,
                bidQty: data.bidQty,
                ask: data.ask,
                askQty: data.askQty,
                timestamp: data.timestamp || new Date().toISOString()
            };

            // Only broadcast if we have at least LTP or relevant data
            if (formattedData.ltp !== undefined) {
                // console.log(`📤 Broadcasting market data for ${formattedData.symbol}`);
                socketIOService.broadcastMarketData(formattedData);
            }


        } catch (error: any) {
            console.error('❌ Error processing market data:', error.message);
        }
    }

    /**
     * Subscribe to symbols
     */
    public subscribeToSymbols(instrumentKeys: string[]): void {
        console.log(`🔔 subscribeToSymbols called with: ${instrumentKeys.join(', ')}`);

        // Update local set
        instrumentKeys.forEach(k => this.subscribedInstruments.add(k));

        if (this.streamer && this.isConnected) {
            this.streamer.subscribe(instrumentKeys, "full");
        } else {
            console.log(`⏳ Upstox WebSocket not connected. Queued ${instrumentKeys.length} instruments.`);
        }
    }

    /**
     * Unsubscribe from symbols
     */
    public unsubscribeFromSymbols(instrumentKeys: string[]): void {
        console.log(`📡 Unsubscribe called for: ${instrumentKeys.join(', ')}`);

        instrumentKeys.forEach(k => this.subscribedInstruments.delete(k));

        if (this.streamer && this.isConnected) {
            this.streamer.unsubscribe(instrumentKeys);
        }
    }

    /**
     * Get connection status
     */
    public getStatus(): { isConnected: boolean; subscribedCount: number; reconnectAttempts: number } {
        return {
            isConnected: this.isConnected,
            subscribedCount: this.subscribedInstruments.size,
            reconnectAttempts: this.reconnectAttempts
        };
    }

    /**
     * Stop the WebSocket service
     */
    public stop(): void {
        console.log('🛑 Stopping Upstox WebSocket service...');

        this.stopMarketHoursMonitoring();
        this.clearMarketOpenTimer();

        if (this.streamer) {
            this.streamer.disconnect();
            // this.streamer = null; // Keep instance or null? Disconnect stops auto-reconnect usually.
        }

        this.isConnected = false;

        if (!this.isWithinMarketHours()) {
            this.scheduleNextMarketOpen();
        }
    }
}

export const upstoxWebSocketService = new UpstoxWebSocketService();
