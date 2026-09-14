import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { errorResponse, unavailableResponse } from "@omniroute/open-sse/utils/error.ts";

export type RateLimitedCredentials = {
  allRateLimited: true;
  retryAfter?: string | number | Date | null;
  retryAfterHuman?: string;
};

export function isAllRateLimitedCredentials(value: unknown): value is RateLimitedCredentials {
  return (
    !!value &&
    typeof value === "object" &&
    (value as RateLimitedCredentials).allRateLimited === true
  );
}

export function rateLimitedProviderResponse(
  provider: string,
  credentials: RateLimitedCredentials
): Response {
  return unavailableResponse(
    HTTP_STATUS.RATE_LIMITED,
    `[${provider}] All accounts rate limited`,
    credentials.retryAfter,
    credentials.retryAfterHuman
  );
}

export type ExpiredCredentials = {
  allExpired: true;
  expiredCount?: number;
  expiredStatus?: string;
};

/** The credential lookup's verdict that every connection of the provider is in a terminal state. */
export function isAllExpiredCredentials(value: unknown): value is ExpiredCredentials {
  return (
    typeof value === "object" &&
    value !== null &&
    "allExpired" in value &&
    value.allExpired === true
  );
}

/** Lease-scoped selection verdict (auth.ts returns it only when options.lease is passed). */
export type LeaseConnectionMismatchCredentials = { leaseConnectionMismatch: boolean };

export function isLeaseConnectionMismatchCredentials(
  value: unknown
): value is LeaseConnectionMismatchCredentials {
  return (
    typeof value === "object" &&
    value !== null &&
    "leaseConnectionMismatch" in value &&
    value.leaseConnectionMismatch === true
  );
}

/**
 * Same answer as the chat path (src/sse/handlers/chatHelpers.ts): expired or banned accounts are a
 * 401 with a reconnect hint, while credits_exhausted is quota, not invalid credentials, so it is a
 * 402 (#12441).
 */
export function expiredProviderResponse(
  provider: string,
  credentials: ExpiredCredentials
): Response {
  const status = credentials.expiredStatus || "expired";
  const count = credentials.expiredCount || 1;
  const reason =
    status === "credits_exhausted"
      ? "credits exhausted"
      : status === "banned"
        ? "banned by upstream"
        : "authentication expired";
  return errorResponse(
    status === "credits_exhausted" ? HTTP_STATUS.PAYMENT_REQUIRED : HTTP_STATUS.UNAUTHORIZED,
    `[${provider}] All ${count} connection(s) ${reason} — please reconnect in the dashboard`
  );
}
