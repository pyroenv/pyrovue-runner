/** A token bucket: `capacity` tokens to start, refilled at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = clock();
  }

  /** Takes `cost` tokens if there are enough; returns false (taking nothing) otherwise. */
  take(cost = 1): boolean {
    const now = this.clock();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) / 1000) * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
