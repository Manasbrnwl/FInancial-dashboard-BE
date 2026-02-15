import { upstoxWebSocketService } from '../services/upstoxWebsocketService';
import { devLog, devError } from './errorLogger';

/**
 * WebSocket Manager - Arbitrage functionality
 * Subscribe/unsubscribe to specific symbols (instrument keys) for monitoring
 * Now uses Upstox WebSocket API
 */
export class WebSocketManager {

  /**
   * Subscribe to a list of instrument keys (e.g., "NSE_EQ|INE848E01016")
   */
  public static subscribeToSymbols(instrumentKeys: string[]): void {
    const status = upstoxWebSocketService.getStatus();

    if (!status.isConnected) {
      devError('❌ Cannot subscribe: Upstox WebSocket not connected');
      return;
    }

    upstoxWebSocketService.subscribeToSymbols(instrumentKeys);
    devLog('📡 Subscription request sent for instruments:', instrumentKeys);
  }

  /**
   * Unsubscribe from a list of instrument keys
   */
  public static unsubscribeFromSymbols(instrumentKeys: string[]): void {
    const status = upstoxWebSocketService.getStatus();

    if (!status.isConnected) {
      devError('❌ Cannot unsubscribe: Upstox WebSocket not connected');
      return;
    }

    upstoxWebSocketService.unsubscribeFromSymbols(instrumentKeys);
    devLog('📡 Unsubscription request sent for instruments:', instrumentKeys);
  }

  /**
   * Get current WebSocket status
   */
  public static getStatus(): { isConnected: boolean; reconnectAttempts: number; subscribedCount: number } {
    return upstoxWebSocketService.getStatus();
  }

  /**
   * Stop WebSocket service
   */
  public static stop(): void {
    upstoxWebSocketService.stop();
  }

  /**
   * Start WebSocket service
   */
  public static async start(): Promise<void> {
    await upstoxWebSocketService.start();
  }
}

// Export individual functions for convenience
export const {
  subscribeToSymbols,
  unsubscribeFromSymbols,
  getStatus,
  stop
} = WebSocketManager;
