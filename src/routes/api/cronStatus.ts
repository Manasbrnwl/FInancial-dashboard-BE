import { Router, Request, Response } from 'express';
import { getAllJobStatuses } from '../../utils/cronMonitor';

const router = Router();

/**
 * GET /api/cron-status
 * Get status of all cron jobs including last run, next run, and duration
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const statuses = getAllJobStatuses();

    res.json({
      success: true,
      data: statuses,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error fetching cron status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cron status',
      message: error.message
    });
  }
});

export default router;
