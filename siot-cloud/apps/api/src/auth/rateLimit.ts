// 단일 머신 인메모리 토큰 버킷(계획 §2 속도 제한: 키당 20 req/s 버스트 40, 기기당 제어 5 req/s).
export interface TakeResult {
  ok: boolean;
  /** ok=false 일 때 Retry-After(초, ≥1) */
  retryAfterSec: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    readonly ratePerSec: number,
    readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  take(key: string): TakeResult {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 50_000) this.sweep(t);
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.ratePerSec);
      b.at = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.ratePerSec)) };
  }

  private sweep(t: number): void {
    const full = (this.burst / this.ratePerSec) * 1000;
    for (const [k, b] of this.buckets) if (t - b.at > full) this.buckets.delete(k);
  }
}
