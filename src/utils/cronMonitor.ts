import fs from 'fs';
import path from 'path';
const parser = require('cron-parser');

const HISTORY_FILE = path.join(__dirname, '../../history.json');

export interface CronJobStatus {
  lastRun: string | null;
  nextRun: string | null;
  status: 'idle' | 'running' | 'success' | 'failed';
  lastDuration: number | null;
  errorMessage?: string;
}

export interface CronHistory {
  [jobName: string]: CronJobStatus;
}

/**
 * Load cron history from JSON file
 */
export function loadHistory(): CronHistory {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading cron history:', error);
  }
  return {};
}

/**
 * Save cron history to JSON file
 */
export function saveHistory(history: CronHistory): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('Error saving cron history:', error);
  }
}

/**
 * Calculate next run time based on cron expression
 */
export function getNextCronRun(cronExpression: string): string {
  try {
    const interval = parser.parseExpression(cronExpression);
    return interval.next().toDate().toISOString();
  } catch (error) {
    console.error('Error calculating next cron run:', error);
    return '';
  }
}

/**
 * Update job status in history
 */
export function updateJobStatus(
  jobName: string,
  status: 'running' | 'success' | 'failed',
  cronExpression: string,
  duration?: number,
  error?: string
): void {
  const history = loadHistory();

  const currentStatus = history[jobName];

  history[jobName] = {
    lastRun: new Date().toISOString(),
    nextRun: status === 'success' || status === 'failed'
      ? getNextCronRun(cronExpression)
      : currentStatus?.nextRun || null,
    status,
    lastDuration: duration !== undefined ? duration : currentStatus?.lastDuration || null,
    errorMessage: error || undefined
  };

  saveHistory(history);

  console.log(`[CronMonitor] ${jobName} - Status: ${status}${duration ? `, Duration: ${duration}ms` : ''}`);
}

/**
 * Get all job statuses
 */
export function getAllJobStatuses(): CronHistory {
  return loadHistory();
}

/**
 * Initialize job status on startup (sets initial nextRun)
 */
export function initializeJobStatus(jobName: string, cronExpression: string): void {
  const history = loadHistory();

  if (!history[jobName]) {
    history[jobName] = {
      lastRun: null,
      nextRun: getNextCronRun(cronExpression),
      status: 'idle',
      lastDuration: null
    };
    saveHistory(history);
    console.log(`[CronMonitor] Initialized ${jobName}`);
  } else {
    // Update nextRun on restart
    history[jobName].nextRun = getNextCronRun(cronExpression);
    history[jobName].status = 'idle';
    saveHistory(history);
    console.log(`[CronMonitor] Reinitialized ${jobName}`);
  }
}
