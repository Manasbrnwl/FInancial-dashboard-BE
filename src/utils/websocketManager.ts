import { webSocketService } from '../services/websocketService';

/**
 * WebSocket Manager utility functions
 */
export class WebSocketManager {

  /**
   * Subscribe to a list of symbols
   */
  public static subscribeToSymbols(symbols: string[]): void {
    const status = webSocketService.getStatus();

    if (!status.isConnected) {
      console.error('❌ Cannot subscribe: WebSocket not connected');
      return;
    }

    webSocketService.subscribeToSymbols(symbols);
    console.log('📡 Subscription request sent for symbols:', symbols);
  }

  /**
   * Unsubscribe from a list of symbols
   */
  public static unsubscribeFromSymbols(symbols: string[]): void {
    const status = webSocketService.getStatus();

    if (!status.isConnected) {
      console.error('❌ Cannot unsubscribe: WebSocket not connected');
      return;
    }

    webSocketService.unsubscribeFromSymbols(symbols);
    console.log('📡 Unsubscription request sent for symbols:', symbols);
  }

  /**
   * Get current WebSocket status
   */
  public static getStatus(): { isConnected: boolean; reconnectAttempts: number } {
    return webSocketService.getStatus();
  }

  /**
   * Subscribe to commonly traded NSE symbols
   */
  public static subscribeToNseTopSymbols(): void {
    const nseTopSymbols = [
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'HINDUNILVR',
      'ICICIBANK', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
      'ASIANPAINT', 'LT', 'AXISBANK', 'MARUTI', 'SUNPHARMA',
      'TITAN', 'ULTRACEMCO', 'BAJFINANCE', 'HCLTECH', 'WIPRO'
    ];

    this.subscribeToSymbols(nseTopSymbols);
  }

  /**
   * Subscribe to commonly traded NSE F&O symbols
   */
  public static subscribeToNseFOSymbols(): void {
    const nseFOSymbols = [
      'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
      'ITC', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'BAJFINANCE'
    ];

    this.subscribeToSymbols(nseFOSymbols);
  }

  /**
   * Subscribe to specific sectors
   */
  public static subscribeToBankingSymbols(): void {
    const bankingSymbols = [
      'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK',
      'INDUSINDBK', 'FEDERALBNK', 'BANDHANBNK', 'IDFCFIRSTB', 'PNB'
    ];

    this.subscribeToSymbols(bankingSymbols);
  }

  public static subscribeToITSymbols(): void {
    const itSymbols = [
      'TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM',
      'LTTS', 'MINDTREE', 'MPHASIS', 'COFORGE', 'LTIM'
    ];

    this.subscribeToSymbols(itSymbols);
  }

  /**
   * Stop WebSocket service
   */
  public static stop(): void {
    webSocketService.stop();
  }

  /**
   * Restart WebSocket service
   */
  public static async restart(): Promise<void> {
    console.log('🔄 Restarting WebSocket service...');
    webSocketService.stop();

    // Wait a moment before restarting
    setTimeout(async () => {
      await webSocketService.start();
    }, 2000);
  }
}

// Export individual functions for convenience
export const {
  subscribeToSymbols,
  unsubscribeFromSymbols,
  getStatus,
  subscribeToNseTopSymbols,
  subscribeToNseFOSymbols,
  subscribeToBankingSymbols,
  subscribeToITSymbols,
  stop,
  restart
} = WebSocketManager;