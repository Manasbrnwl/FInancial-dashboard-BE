import cluster from 'cluster';
import os from 'os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the number of CPU cores available on the system
const numCPUs = os.cpus().length;

/**
 * Initialize clustering to utilize all available CPU cores
 * @param primaryCallback Function to execute in the primary process
 * @param workerCallback Function to execute in each worker process
 */
export function initializeClusters(
  primaryCallback: () => void,
  workerCallback: () => void
): void {
  // Check if this is the primary process
  if (cluster.isPrimary) {
    console.log(`🧠 Primary ${process.pid} is running`);
    console.log(`🔄 Starting ${numCPUs} workers...`);

    // Fork workers equal to the number of CPU cores
    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }

    // Log when a worker exits
    cluster.on('exit', (worker, code, signal) => {
      console.log(`⚠️ Worker ${worker.process.pid} died with code: ${code} and signal: ${signal}`);
      console.log('🔄 Starting a new worker...');
      cluster.fork(); // Replace the dead worker
    });

    // Execute the primary process callback
    primaryCallback();
  } else {
    // This is a worker process
    console.log(`👷 Worker ${process.pid} started`);
    
    // Execute the worker process callback
    workerCallback();
  }
}