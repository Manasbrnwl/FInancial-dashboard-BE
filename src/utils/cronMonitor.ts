import { CronExpressionParser } from 'cron-parser';
import prisma from '../config/prisma';
import { devLog, devError, prodError } from "./errorLogger";

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
 * Calculate next run time based on cron expression
 */
export function getNextCronRun(cronExpression: string): string {
  try {
    const interval = CronExpressionParser.parse(cronExpression);
    return interval.next().toDate().toISOString();
  } catch (error) {
    devError('Error calculating next cron run:', error);
    prodError('Failed to calculate next cron run');
    return '';
  }
}

/**
 * Update job status in the DB-backed history. Stored in market_data.cron_job_status
 * (not a local file) so any process — api, realtime, or sync-worker — can read the
 * status regardless of which process actually ran the job.
 */
export async function updateJobStatus(
  jobName: string,
  status: 'running' | 'success' | 'failed',
  cronExpression: string,
  duration?: number,
  error?: string
): Promise<void> {
  try {
    const nextRun = status === 'success' || status === 'failed'
      ? new Date(getNextCronRun(cronExpression))
      : undefined;

    await prisma.cron_job_status.upsert({
      where: { job_name: jobName },
      create: {
        job_name: jobName,
        last_run: new Date(),
        next_run: nextRun ?? new Date(getNextCronRun(cronExpression)),
        status,
        last_duration_ms: duration ?? null,
        error_message: error ?? null,
      },
      update: {
        last_run: new Date(),
        ...(nextRun ? { next_run: nextRun } : {}),
        status,
        ...(duration !== undefined ? { last_duration_ms: duration } : {}),
        error_message: error ?? null,
      },
    });

    devLog(`[CronMonitor] ${jobName} - Status: ${status}${duration ? `, Duration: ${duration}ms` : ''}`);
  } catch (err) {
    devError('Error updating cron job status:', err);
    prodError('Failed to update cron job status');
  }
}

/**
 * Get all job statuses
 */
export async function getAllJobStatuses(): Promise<CronHistory> {
  const rows = await prisma.cron_job_status.findMany();
  const history: CronHistory = {};
  for (const row of rows) {
    history[row.job_name] = {
      lastRun: row.last_run ? row.last_run.toISOString() : null,
      nextRun: row.next_run ? row.next_run.toISOString() : null,
      status: row.status as CronJobStatus['status'],
      lastDuration: row.last_duration_ms,
      errorMessage: row.error_message ?? undefined,
    };
  }
  return history;
}

/**
 * Initialize job status on startup (sets initial nextRun)
 */
export async function initializeJobStatus(jobName: string, cronExpression: string): Promise<void> {
  await prisma.cron_job_status.upsert({
    where: { job_name: jobName },
    create: {
      job_name: jobName,
      status: 'idle',
      next_run: new Date(getNextCronRun(cronExpression)),
    },
    update: {
      status: 'idle',
      next_run: new Date(getNextCronRun(cronExpression)),
    },
  });
  devLog(`[CronMonitor] Initialized ${jobName}`);
}

/**
 * Wrap a cron job's execution function so its status is recorded in
 * cron_job_status before/after every run — call once, pass the result to
 * cron.schedule(). Registers the job's idle/nextRun status immediately.
 */
export function withJobTracking(
  jobName: string,
  cronExpression: string,
  fn: () => Promise<void> | void
): () => Promise<void> {
  initializeJobStatus(jobName, cronExpression);

  return async () => {
    const start = Date.now();
    await updateJobStatus(jobName, 'running', cronExpression);
    try {
      await fn();
      await updateJobStatus(jobName, 'success', cronExpression, Date.now() - start);
    } catch (error: any) {
      await updateJobStatus(jobName, 'failed', cronExpression, Date.now() - start, error?.message);
      throw error;
    }
  };
}
