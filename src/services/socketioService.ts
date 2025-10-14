import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';

interface MarketData {
  symbol?: string;
  price?: number;
  volume?: number;
  timestamp?: string;
  [key: string]: any;
}

export class SocketIOService {
  private io: SocketIOServer | null = null;
  private connectedClients: Set<string> = new Set();

  /**
   * Initialize Socket.io server
   */
  public initialize(httpServer: HTTPServer): void {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: ['http://localhost:5173', 'http://localhost:3000'],
        credentials: true,
        methods: ['GET', 'POST']
      },
      transports: ['websocket', 'polling']
    });

    this.setupEventHandlers();
    console.log('🔌 Socket.io server initialized');
  }

  /**
   * Setup Socket.io event handlers
   */
  private setupEventHandlers(): void {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      console.log(`✅ Client connected: ${socket.id}`);
      this.connectedClients.add(socket.id);

      // Send welcome message
      socket.emit('connection-status', {
        status: 'connected',
        clientId: socket.id,
        timestamp: new Date().toISOString()
      });

      // Handle client subscription to specific symbols
      socket.on('subscribe-symbols', (symbols: string[]) => {
        console.log(`📡 Client ${socket.id} subscribing to:`, symbols);

        // Join rooms for each symbol
        symbols.forEach(symbol => {
          socket.join(`symbol:${symbol}`);
        });

        socket.emit('subscription-confirmed', {
          symbols,
          timestamp: new Date().toISOString()
        });
      });

      // Handle client unsubscription
      socket.on('unsubscribe-symbols', (symbols: string[]) => {
        console.log(`📡 Client ${socket.id} unsubscribing from:`, symbols);

        symbols.forEach(symbol => {
          socket.leave(`symbol:${symbol}`);
        });

        socket.emit('unsubscription-confirmed', {
          symbols,
          timestamp: new Date().toISOString()
        });
      });

      // Handle client requesting current subscriptions
      socket.on('get-subscriptions', () => {
        const rooms = Array.from(socket.rooms)
          .filter(room => room.startsWith('symbol:'))
          .map(room => room.replace('symbol:', ''));

        socket.emit('current-subscriptions', {
          symbols: rooms,
          timestamp: new Date().toISOString()
        });
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
        this.connectedClients.delete(socket.id);
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error(`❌ Socket error for client ${socket.id}:`, error);
      });
    });
  }

  /**
   * Broadcast market data to all connected clients
   */
  public broadcastMarketData(data: MarketData): void {
    if (!this.io) {
      console.warn('⚠️ Socket.io not initialized');
      return;
    }

    // Broadcast to all clients
    this.io.emit('market-data', {
      ...data,
      timestamp: data.timestamp || new Date().toISOString()
    });

    // Also broadcast to symbol-specific room if symbol is present
    if (data.symbol) {
      this.io.to(`symbol:${data.symbol}`).emit('symbol-update', {
        ...data,
        timestamp: data.timestamp || new Date().toISOString()
      });
    }
  }

  /**
   * Broadcast to specific symbol subscribers only
   */
  public broadcastToSymbol(symbol: string, data: MarketData): void {
    if (!this.io) {
      console.warn('⚠️ Socket.io not initialized');
      return;
    }

    this.io.to(`symbol:${symbol}`).emit('symbol-update', {
      ...data,
      symbol,
      timestamp: data.timestamp || new Date().toISOString()
    });
  }

  /**
   * Broadcast bulk market data (array of updates)
   */
  public broadcastBulkMarketData(dataArray: MarketData[]): void {
    if (!this.io) {
      console.warn('⚠️ Socket.io not initialized');
      return;
    }

    this.io.emit('market-data-bulk', {
      data: dataArray,
      count: dataArray.length,
      timestamp: new Date().toISOString()
    });

    // Also emit individual symbol updates
    dataArray.forEach(data => {
      if (data.symbol) {
        this.io!.to(`symbol:${data.symbol}`).emit('symbol-update', {
          ...data,
          timestamp: data.timestamp || new Date().toISOString()
        });
      }
    });
  }

  /**
   * Get count of connected clients
   */
  public getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Get list of connected client IDs
   */
  public getConnectedClients(): string[] {
    return Array.from(this.connectedClients);
  }

  /**
   * Get Socket.io instance
   */
  public getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Broadcast connection status to all clients
   */
  public broadcastConnectionStatus(status: 'connected' | 'disconnected' | 'reconnecting'): void {
    if (!this.io) return;

    this.io.emit('websocket-status', {
      status,
      timestamp: new Date().toISOString()
    });
  }
}

// Export singleton instance
export const socketIOService = new SocketIOService();
