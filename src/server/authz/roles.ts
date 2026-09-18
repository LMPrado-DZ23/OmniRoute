import { isAccessScope, type AccessScope } from "@/lib/accessTokens/scopes";
import type { AuthSubject } from "./types";

/**
 * Management roles — a NAMING layer over the credentials OmniRoute already has.
 *
 * There are no user or role tables (see docs/architecture/WORKSPACES_RBAC.md). A role is
 * derived from the authenticated management subject the central policy produced, so it can
 * never grant anything the underlying credential does not already grant:
 *
 *   owner    — dashboard session, loopback CLI machine token, or management with auth disabled.
 *              Full access, including LOCAL_ONLY host-control routes from loopback.
 *   admin    — API key holding `manage`/`admin`, or a CLI access token with scope `admin`.
 *   operator — CLI access token with scope `write` (reads + non-sensitive mutations).
 *   viewer   — CLI access token with scope `read` (GET/HEAD/OPTIONS only).
 *
 * Which method/path each access-token scope may call is decided by `inferRequiredScope`
 * (`src/server/authz/accessScopes.ts`); API keys are all-or-nothing for management today.
 * Client API keys (no management scope), the narrow `mcp:connect` scope and in-process
 * service principals (model sync, WS bridge, inspector ingest, internal service token) have
 * no management role: `null`.
 */
type ManagementRole = "owner" | "admin" | "operator" | "viewer";

const ACCESS_SCOPE_ROLE: Readonly<Record<AccessScope, ManagementRole>> = {
  admin: "admin",
  write: "operator",
  read: "viewer",
};

const ACCESS_TOKEN_LABEL_PREFIX = "access-token:";

function roleForManagementKeyLabel(label: string): ManagementRole | null {
  if (label === "local-cli-token") return "owner";
  if (label.startsWith(ACCESS_TOKEN_LABEL_PREFIX)) {
    const scope = label.slice(ACCESS_TOKEN_LABEL_PREFIX.length);
    return isAccessScope(scope) ? ACCESS_SCOPE_ROLE[scope] : null;
  }
  // `api-key-manage-scope`, `api-key-admin-scope-…`: a manage/admin API key. The narrow
  // `mcp:connect` carve-out labels (`api-key-mcp-connect-scope-…`) are not management roles.
  if (label.startsWith("api-key-") && !label.startsWith("api-key-mcp-connect")) return "admin";
  return null;
}

/** Resolve the management role of an authenticated subject, or `null` when it has none. */
export function resolveManagementRole(
  subject: Pick<AuthSubject, "kind" | "label">
): ManagementRole | null {
  const label = subject.label ?? "";
  switch (subject.kind) {
    case "dashboard_session":
      return "owner";
    case "anonymous":
      return label === "auth-disabled" ? "owner" : null;
    case "management_key":
      return roleForManagementKeyLabel(label);
    default:
      return null;
  }
}
