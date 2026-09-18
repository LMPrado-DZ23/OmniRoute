import { presentApiError } from "@/shared/utils/apiErrorPresentation";

/**
 * Readable text for a failed `/api/webhooks*` response (audit C H1).
 *
 * The webhook routes answer in two shapes: `{ error: "text" }` and the shared validation
 * envelope `{ error: { message, details: [{ field, message }] } }`. Passing `data.error`
 * straight to `new Error()` rendered the envelope as `[object Object]`. This keeps the
 * shared headline logic (`presentApiError`) and appends the per-field validation messages so
 * the user sees which field was rejected and why.
 */
export function describeWebhookApiError(body: unknown, fallback: string, status?: number): string {
  const { message } = presentApiError(body, { fallback, status });
  const details = readValidationDetails(body);
  return details.length > 0 ? `${message}: ${details.join("; ")}` : message;
}

function readValidationDetails(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return [];
  const details = (error as Record<string, unknown>).details;
  if (!Array.isArray(details)) return [];
  return details.map(formatDetail).filter((text): text is string => text !== null);
}

function formatDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) return null;
  const field = typeof record.field === "string" ? record.field.trim() : "";
  return field ? `${field}: ${message}` : message;
}
