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
 * Subscribe to specific symbols
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

/**
 * Subscribe to predefined symbol groups
 */
router.post('/subscribe/group/:groupName', (req: Request, res: Response) => {
  try {
    const { groupName } = req.params;

    switch (groupName.toLowerCase()) {
      case 'nse-top':
        WebSocketManager.subscribeToNseTopSymbols();
        break;
      case 'nse-fo':
        WebSocketManager.subscribeToNseFOSymbols();
        break;
      case 'banking':
        WebSocketManager.subscribeToBankingSymbols();
        break;
      case 'it':
        WebSocketManager.subscribeToITSymbols();
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unknown group: ${groupName}. Available groups: nse-top, nse-fo, banking, it`,
          timestamp: new Date().toISOString()
        });
    }

    res.json({
      success: true,
      message: `Subscription request sent for ${groupName} symbols`,
      group: groupName,
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
 * Restart WebSocket service
 */
router.post('/restart', async (req: Request, res: Response) => {
  try {
    await WebSocketManager.restart();

    res.json({
      success: true,
      message: 'WebSocket service restart initiated',
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
 * Stop WebSocket service
 */
router.post('/stop', (req: Request, res: Response) => {
  try {
    WebSocketManager.stop();

    res.json({
      success: true,
      message: 'WebSocket service stopped',
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