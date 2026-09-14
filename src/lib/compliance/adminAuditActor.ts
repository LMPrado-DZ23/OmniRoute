import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import {
  AUTHZ_HEADER_AUTH_ID,
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
} from "@/server/authz/headers";
import { resolveManagementRole } from "@/server/authz/roles";
import type { AuthSubject } from "@/server/authz/types";

/**
 * Audit helper for administrative mutations.
 *
 * The central authz pipeline stamps the authenticated subject onto the forwarded request
 * (`x-omniroute-auth-kind|id|label`) after stripping any client-supplied copy, so route
 * handlers can attribute an admin change to a principal and its management role without
 * re-running auth. A request that never went through the pipeline (direct in-process
 * handler invocation) is recorded as the generic `admin` actor with `role: null`.
 *
 * Callers must pass identifiers and field names only — never key material, token secrets,
 * token hashes or provider credentials.
 */

const SUBJECT_KINDS: ReadonlySet<string> = new Set([
  "client_api_key",
  "dashboard_session",
  "management_key",
  "anonymous",
]);

function isSubjectKind(value: string | null): value is AuthSubject["kind"] {
  return value !== null && SUBJECT_KINDS.has(value);
}

function resolveActor(request: Request) {
  const kind = request.headers.get(AUTHZ_HEADER_AUTH_KIND);
  if (!isSubjectKind(kind)) return { actor: "admin", role: null, authLabel: null };
  const label = request.headers.get(AUTHZ_HEADER_AUTH_LABEL);
  const id = request.headers.get(AUTHZ_HEADER_AUTH_ID) || "unknown";
  return {
    actor: `${kind}:${id}`,
    role: resolveManagementRole({ kind, label: label ?? undefined }),
    authLabel: label,
  };
}

interface AdminAuditEntry {
  action: string;
  target?: string;
  resourceType: string;
  status?: "success" | "failed";
  metadata?: Record<string, unknown>;
}

export function logAdminAuditEvent(request: Request, entry: AdminAuditEntry): void {
  const context = getAuditRequestContext(request);
  const who = resolveActor(request);
  logAuditEvent({
    action: entry.action,
    actor: who.actor,
    target: entry.target,
    resourceType: entry.resourceType,
    status: entry.status ?? "success",
    ipAddress: context.ipAddress || undefined,
    requestId: context.requestId,
    metadata: { ...entry.metadata, role: who.role, authLabel: who.authLabel },
  });
}
