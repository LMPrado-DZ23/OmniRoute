import { NextResponse } from "next/server";
import type { z } from "zod";

import { logAdminAuditEvent } from "@/lib/compliance/adminAuditActor";
import * as log from "@/sse/utils/logger";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

/** Shared plumbing of the `/api/workspaces/**` handlers. */

export function errorJson(status: number, message: string, code?: string): Response {
  return NextResponse.json({ error: code ? { message, code } : { message } }, { status });
}

export const PROJECT_NOT_FOUND_BODY = { error: { message: "Project not found" } } as const;

export function projectNotFound(): Response {
  return NextResponse.json(PROJECT_NOT_FOUND_BODY, { status: 404 });
}

export const BUDGET_EXCEEDS_PARENT_MESSAGE =
  "A project budget cannot exceed its workspace budget on the same interval";

/** Parse + validate a JSON body. Exactly one of `data` / `response` is set. */
export async function parseBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema
): Promise<{ data: z.infer<TSchema> | null; response: Response | null }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { data: null, response: errorJson(400, "Invalid JSON body") };
  }
  const validation = validateBody(schema, raw);
  if (isValidationFailure(validation)) {
    return {
      data: null,
      response: NextResponse.json({ error: validation.error }, { status: 400 }),
    };
  }
  return { data: validation.data, response: null };
}

/** Record a successful workspace mutation. Identifiers and field names only. */
export function auditWorkspaceChange(
  request: Request,
  action: string,
  target: string,
  metadata: Record<string, unknown> = {}
): void {
  logAdminAuditEvent(request, { action, target, resourceType: "workspace", metadata });
}

function internalError(): Response {
  return errorJson(500, "Workspace operation failed");
}

/**
 * The 500 path of every `/api/workspaces/**` verb: an unexpected failure (a database error,
 * say) answers with the same JSON envelope as the other refusals instead of Next's default
 * error page, and the reason is logged server-side only.
 */
export async function withWorkspaceErrors(handle: () => Promise<Response>): Promise<Response> {
  try {
    return await handle();
  } catch (error) {
    log.error("workspaces", "Workspace request failed", error);
    return internalError();
  }
}
