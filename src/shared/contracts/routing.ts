/**
 * Shared routing contract: types used by routing code in both src/ and open-sse/. Consumers import
 * them from here instead of declaring look-alike copies. Type-only; no runtime code.
 */

/** One weighted input of a routing score. */
export interface RoutingFactor {
  /** Factor name (quota, health, cost, latency, task_fit, stability, ...). */
  name: string;
  /** Raw factor value, normally within [0, 1]. */
  value: number;
  /** Weight applied to this factor. */
  weight: number;
  /** Weighted contribution (value × weight). */
  contribution: number;
}

/** Circuit breaker state as the routing scorer reads it. */
export type RoutingCircuitState = "closed" | "open" | "half_open";
