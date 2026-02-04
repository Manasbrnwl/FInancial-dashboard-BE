declare module 'upstox-js-sdk' {
    export class ApiClient {
        static instance: ApiClient;
        authentications: {
            'OAUTH2': {
                accessToken: string;
            }
        };
        [key: string]: any;
    }

    export class MarketDataStreamerV3 {
        constructor(instrumentKeys: string[], mode: string);
        on(event: string, callback: (data: any) => void): void;
        autoReconnect(enable: boolean, interval: number, retryCount: number): void;
        connect(): Promise<void>;
        disconnect(): void;
        subscribe(instrumentKeys: string[], mode: string): void;
        unsubscribe(instrumentKeys: string[]): void;
        changeMode(instrumentKeys: string[], newMode: string): void;
        [key: string]: any;
    }
}
