/**
 * Type-only declarations for provider credential selection (src/sse/services/auth.ts). They live in
 * a leaf module so the frozen auth.ts does not grow with type declarations; auth.ts imports the ones
 * it uses and re-exports ExclusiveLeaseSelectionResult.
 */
import type { ExclusiveConnectionLease } from "@/lib/db/exclusiveConnectionLeases";
import type { CredentialLeaseSelectionContext } from "./exclusiveConnectionLeasePolicy";

export interface CredentialSelectionOptions {
  allowSuppressedConnections?: boolean;
  allowRateLimitedConnections?: boolean;
  bypassQuotaPolicy?: boolean;
  forcedConnectionId?: string | null;
  excludeConnectionIds?: string[] | null;
  sessionKey?: string | null;
  sessionAffinityTtlMs?: number | null;
  reserveOAuthSession?: boolean;
  lease?: CredentialLeaseSelectionContext;
  materializeCredentials?: boolean;
  deferLeaseClaim?: boolean;
  /** Internal: a same-call UNIQUE retry already holds the provider/owner selection lock. */
  _leaseRetryWithLockHeld?: boolean;
  /** Internal: freeze the original policy-valid candidate set across lease race/preflight retry. */
  _leaseCandidateIds?: string[];
}
export type ExclusiveLeaseSelectionResult = {
  exclusiveLease: ExclusiveConnectionLease;
  connectionId: string;
  provider: string;
};

/** Verdict shapes returned only when `options.lease` is passed (see exclusiveConnectionLeasePolicy). */
type LeaseOnlyCredentialVerdict =
  | { leaseConnectionMismatch: unknown }
  | { leaseRequired: unknown }
  | { leaseFenceStale: unknown }
  | { waitingForCapacity: unknown }
  | { exclusiveLease: unknown }
  // `{ [leasePolicy.error]: true }` is inferred as a boolean record.
  | Record<string, boolean>;

export type WithoutLeaseOnlyCredentialVerdicts<T> = T extends LeaseOnlyCredentialVerdict
  ? never
  : T;
export type CredentialSelectionOptionsWithoutLease = Omit<CredentialSelectionOptions, "lease"> & {
  lease?: undefined;
};
