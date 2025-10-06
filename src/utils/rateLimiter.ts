/**
 * Rate Limiter Utility
 *
 * API Rate Limits for Tick History:
 * - Per second: 5 requests
 * - Per minute: 300 requests
 * - Per hour: 18,000 requests
 */

class RateLimiter {
  private requestsPerSecond: number[] = [];
  private requestsPerMinute: number[] = [];
  private requestsPerHour: number[] = [];

  private readonly MAX_PER_SECOND = 5;
  private readonly MAX_PER_MINUTE = 300;
  private readonly MAX_PER_HOUR = 18000;

  /**
   * Clean up old requests from the tracking arrays
   */
  private cleanup(now: number): void {
    const oneSecondAgo = now - 1000;
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    this.requestsPerSecond = this.requestsPerSecond.filter(
      (time) => time > oneSecondAgo
    );
    this.requestsPerMinute = this.requestsPerMinute.filter(
      (time) => time > oneMinuteAgo
    );
    this.requestsPerHour = this.requestsPerHour.filter(
      (time) => time > oneHourAgo
    );
  }

  /**
   * Check if we can make a request without exceeding rate limits
   */
  canMakeRequest(): boolean {
    const now = Date.now();
    this.cleanup(now);

    return (
      this.requestsPerSecond.length < this.MAX_PER_SECOND &&
      this.requestsPerMinute.length < this.MAX_PER_MINUTE &&
      this.requestsPerHour.length < this.MAX_PER_HOUR
    );
  }

  /**
   * Record a request
   */
  recordRequest(): void {
    const now = Date.now();
    this.requestsPerSecond.push(now);
    this.requestsPerMinute.push(now);
    this.requestsPerHour.push(now);
  }

  /**
   * Calculate wait time until next request can be made
   */
  getWaitTime(): number {
    const now = Date.now();
    this.cleanup(now);

    if (this.requestsPerSecond.length >= this.MAX_PER_SECOND) {
      const oldestInSecond = this.requestsPerSecond[0];
      return Math.max(0, 1000 - (now - oldestInSecond) + 100); // +100ms buffer
    }

    if (this.requestsPerMinute.length >= this.MAX_PER_MINUTE) {
      const oldestInMinute = this.requestsPerMinute[0];
      return Math.max(0, 60000 - (now - oldestInMinute) + 100); // +100ms buffer
    }

    if (this.requestsPerHour.length >= this.MAX_PER_HOUR) {
      const oldestInHour = this.requestsPerHour[0];
      return Math.max(0, 3600000 - (now - oldestInHour) + 100); // +100ms buffer
    }

    return 0;
  }

  /**
   * Wait until we can make a request
   */
  async waitForSlot(): Promise<void> {
    while (!this.canMakeRequest()) {
      const waitTime = this.getWaitTime();
      if (waitTime > 0) {
        console.log(`⏳ Rate limit reached. Waiting ${waitTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    this.recordRequest();
  }

  /**
   * Get current usage statistics
   */
  getStats(): {
    perSecond: number;
    perMinute: number;
    perHour: number;
  } {
    const now = Date.now();
    this.cleanup(now);

    return {
      perSecond: this.requestsPerSecond.length,
      perMinute: this.requestsPerMinute.length,
      perHour: this.requestsPerHour.length,
    };
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.requestsPerSecond = [];
    this.requestsPerMinute = [];
    this.requestsPerHour = [];
  }
}

// Export a singleton instance
export const rateLimiter = new RateLimiter();
