import dotenv from "dotenv";
import { loadEnv } from "./config/env";
import { startApiServer } from "./servers/api";
import { startRealtimeServer } from "./servers/realtime";
import { startSyncWorker } from "./workers/sync";

dotenv.config();
loadEnv();

/**
 * Local development convenience entrypoint — runs all three production
 * processes (api, realtime, sync-worker; see src/servers/ and src/workers/)
 * in one Node process on three ports, so `npm run dev` still gives a full
 * working stack without juggling three terminals. Production runs these as
 * separate containers/processes (see docker-compose.yml) for isolation.
 */
startApiServer();
startRealtimeServer();
startSyncWorker();
