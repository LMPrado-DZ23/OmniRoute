import { isApiKeyRevealEnabledFlag } from "@/shared/utils/featureFlags";
import {
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
  CLI_TOKEN_HEADER,
} from "@/server/authz/headers";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * `ALLOW_API_KEY_REVEAL` now governs ONLY the reveal of stored third-party PROVIDER
 * credentials on the providers page. OmniRoute's own API keys are never revealable (#7
 * reveal-once): a key is shown in full exactly once — in the create / regenerate responses —
 * and every listing carries only `maskStoredApiKey`'s form.
 */
function isApiKeyRevealEnabled(): boolean {
  try {
    return isApiKeyRevealEnabledFlag();
  } catch {
    const raw = String(process.env.ALLOW_API_KEY_REVEAL || "")
      .trim()
      .toLowerCase();
    return ENABLED_VALUES.has(raw);
  }
}

/**
 * True when the authz pipeline authenticated an interactive dashboard subject: a dashboard
 * session, or the anonymous subject of an instance with login disabled. The pipeline
 * (`src/server/authz/pipeline.ts`) strips any client-supplied copy of these headers before it
 * stamps the subject, so they cannot be forged. Every API key or token — whatever header carried
 * it (`Authorization`, `x-api-key`, `x-goog-api-key`, ...) — is stamped `management_key` or
 * `client_api_key`, and a request that did not pass the pipeline carries no stamp at all.
 */
function isDashboardSubject(request: Request): boolean {
  const kind = request.headers.get(AUTHZ_HEADER_AUTH_KIND);
  if (kind === "dashboard_session") return true;
  return kind === "anonymous" && request.headers.get(AUTHZ_HEADER_AUTH_LABEL) === "auth-disabled";
}

/**
 * Defense in depth on top of the subject check: true when the request also carries a
 * programmatic credential — a Bearer token (manage-scope API key or `oma_` CLI access token), an
 * `x-api-key` / `x-goog-api-key`, or the loopback CLI machine token (raw header, or the subject
 * label the authz pipeline stamps after consuming it). Browsers never send these on their own.
 */
function presentsProgrammaticCredential(request: Request): boolean {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (/^bearer\s+\S/i.test(authorization)) return true;
  if (request.headers.get("x-api-key")?.trim()) return true;
  if (request.headers.get("x-goog-api-key")?.trim()) return true;
  if (request.headers.has(CLI_TOKEN_HEADER)) return true;
  return request.headers.get(AUTHZ_HEADER_AUTH_LABEL) === "local-cli-token";
}

/**
 * Whether a stored provider credential may be returned in full on this request.
 *
 * The flag is documented as a dashboard-UI opt-in ("authenticated dashboard users"). Only a
 * subject the authz pipeline identified as the dashboard qualifies (allow-list on the trusted
 * stamp), so a programmatic management credential never receives a full provider credential,
 * even with the flag on, whichever header it used. Default: flag off, so nothing is ever
 * revealed after creation.
 */
export function isProviderCredentialRevealAllowed(request: Request): boolean {
  if (!isDashboardSubject(request)) return false;
  if (presentsProgrammaticCredential(request)) return false;
  return isApiKeyRevealEnabled();
}

export function maskStoredApiKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  return key.slice(0, 8) + "****" + key.slice(-4);
}
