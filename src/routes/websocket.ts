import express, { Request, Response } from 'express';
import { WebSocketManager } from '../utils/websocketManager';

const router = express.Router();

/**
 * Get WebSocket connection status
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    const status = WebSocketManager.getStatus();
    res.json({
      success: true,
      data: status,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Subscribe to specific symbols (for arbitrage monitoring)
 */
router.post('/subscribe', (req: Request, res: Response) => {
  try {
    const { symbols } = req.body;

    if (!symbols || !Array.isArray(symbols)) {
      return res.status(400).json({
        success: false,
        error: 'symbols array is required',
        timestamp: new Date().toISOString()
      });
    }

    WebSocketManager.subscribeToSymbols(symbols);

    res.json({
      success: true,
      message: `Subscription request sent for ${symbols.length} symbols`,
      symbols: symbols,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Unsubscribe from specific symbols
 */
router.post('/unsubscribe', (req: Request, res: Response) => {
  try {
    const { symbols } = req.body;

    if (!symbols || !Array.isArray(symbols)) {
      return res.status(400).json({
        success: false,
        error: 'symbols array is required',
        timestamp: new Date().toISOString()
      });
    }

    WebSocketManager.unsubscribeFromSymbols(symbols);

    res.json({
      success: true,
      message: `Unsubscription request sent for ${symbols.length} symbols`,
      symbols: symbols,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;