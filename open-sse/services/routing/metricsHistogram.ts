/**
 * Fixed-bucket histogram with Prometheus-compatible cumulative buckets and
 * `histogram_quantile`-style percentile estimation (linear interpolation inside
 * the bucket that contains the requested rank).
 *
 * Memory is O(buckets) regardless of traffic — no per-sample storage.
 */

/** Upper bounds (ms) for end-to-end request latency. */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000, 60000, 120000, 300000,
];

/** Upper bounds (ms) for time to first forwarded stream chunk. */
export const TTFT_BUCKETS_MS: readonly number[] = [
  25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000,
];

export interface HistogramSnapshot {
  bounds: readonly number[];
  /** Non-cumulative counts; length = bounds.length + 1 (last = +Inf bucket). */
  counts: number[];
  sum: number;
  count: number;
}

export class FixedHistogram {
  private readonly counts: number[];
  private sum = 0;
  private count = 0;

  constructor(private readonly bounds: readonly number[]) {
    this.counts = new Array<number>(bounds.length + 1).fill(0);
  }

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    let idx = this.bounds.findIndex((bound) => value <= bound);
    if (idx < 0) idx = this.bounds.length;
    this.counts[idx] += 1;
    this.sum += value;
    this.count += 1;
  }

  /** Add another snapshot with identical bounds into this histogram. */
  merge(snapshot: HistogramSnapshot): void {
    for (let i = 0; i < this.counts.length; i++) this.counts[i] += snapshot.counts[i] ?? 0;
    this.sum += snapshot.sum;
    this.count += snapshot.count;
  }

  snapshot(): HistogramSnapshot {
    return { bounds: this.bounds, counts: [...this.counts], sum: this.sum, count: this.count };
  }
}

/**
 * Estimate the q-quantile (0 < q ≤ 1) from a histogram snapshot. Returns null
 * with no samples. Values in the +Inf bucket resolve to the highest finite bound.
 */
export function estimateQuantile(snapshot: HistogramSnapshot, q: number): number | null {
  if (snapshot.count === 0) return null;
  const rank = Math.min(1, Math.max(0, q)) * snapshot.count;
  let cumulative = 0;
  for (let i = 0; i < snapshot.counts.length; i++) {
    const bucketCount = snapshot.counts[i];
    if (bucketCount > 0 && cumulative + bucketCount >= rank) {
      const lower = i === 0 ? 0 : snapshot.bounds[i - 1];
      if (i >= snapshot.bounds.length) return lower;
      const upper = snapshot.bounds[i];
      const fraction = (rank - cumulative) / bucketCount;
      return Math.round(lower + (upper - lower) * fraction);
    }
    cumulative += bucketCount;
  }
  return snapshot.bounds[snapshot.bounds.length - 1] ?? null;
}
