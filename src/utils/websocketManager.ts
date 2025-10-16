import { webSocketService } from '../services/websocketService';

/**
 * WebSocket Manager - Arbitrage functionality
 * Subscribe/unsubscribe to specific symbols for arbitrage monitoring
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
   * Stop WebSocket service
   */
  public static stop(): void {
    webSocketService.stop();
  }
}

// Export individual functions for convenience
export const {
  subscribeToSymbols,
  unsubscribeFromSymbols,
  getStatus,
  stop
} = WebSocketManager;