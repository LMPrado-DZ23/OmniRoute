/**
 * Management-API calls of the first-use flow (validate credential → choose model → test
 * request → first request in the logs). Every call reads the existing HTTP contracts; none
 * of them is new. Failures are returned as values (never thrown) so the wizard can render
 * an actionable error for each one.
 */

export interface ConnectionOption {
  id: string;
  provider: string;
  name: string;
}

type ModelListResult =
  | { kind: "ok"; models: string[] }
  | { kind: "error"; httpStatus: number | null; message: string | null };

export interface ModelTestOutcome {
  ok: boolean;
  httpStatus: number;
  latencyMs: number | null;
  error: string | null;
  statusCode: number | null;
  rateLimited: boolean;
}

export interface RecentRequest {
  model: string;
  status: number | null;
  timestamp: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/** `GET /api/providers` → `{ connections: [...] }`, reduced to what the wizard needs. */
export function toConnectionOptions(body: unknown): ConnectionOption[] {
  const list = asRecord(body)?.connections;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    if (!id) return [];
    const provider = readString(record, "provider") ?? "";
    return [{ id, provider, name: readString(record, "name") ?? (provider || id) }];
  });
}

/** Prefer the connection the user just created; otherwise the first one listed. */
export function pickConnection(
  connections: ConnectionOption[],
  preferredId: string | null
): ConnectionOption | null {
  if (preferredId) {
    const preferred = connections.find((connection) => connection.id === preferredId);
    if (preferred) return preferred;
  }
  return connections[0] ?? null;
}

/** Model ids from `GET /api/providers/{id}/models` (`{ models: [{ id }] }`), de-duplicated. */
function toModelIds(body: unknown): string[] {
  const list = asRecord(body)?.models;
  if (!Array.isArray(list)) return [];
  const ids = list.flatMap((item) => {
    const id = typeof item === "string" ? item.trim() : readString(asRecord(item), "id");
    return id ? [id] : [];
  });
  return Array.from(new Set(ids));
}

/** The model string a client sends: `provider/model` unless the id already carries a prefix. */
export function toClientModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed || trimmed.includes("/") || !provider) return trimmed;
  return `${provider}/${trimmed}`;
}

export async function loadConnectionModels(connectionId: string): Promise<ModelListResult> {
  try {
    const res = await fetch(
      `/api/providers/${encodeURIComponent(connectionId)}/models?chatOnly=true&excludeHidden=true`
    );
    const body = await readJson(res);
    if (!res.ok) {
      return {
        kind: "error",
        httpStatus: res.status,
        message: readString(asRecord(body), "error"),
      };
    }
    return { kind: "ok", models: toModelIds(body) };
  } catch {
    return { kind: "error", httpStatus: null, message: null };
  }
}

function toModelTestOutcome(httpStatus: number, body: unknown): ModelTestOutcome {
  const record = asRecord(body);
  const error = record?.error;
  return {
    ok: httpStatus >= 200 && httpStatus < 300 && record?.status === "ok",
    httpStatus,
    latencyMs: readNumber(record, "latencyMs"),
    error: typeof error === "string" && error.trim() ? error.trim() : null,
    statusCode: readNumber(record, "statusCode"),
    rateLimited: record?.rateLimited === true,
  };
}

/** `POST /api/models/test` — a short request routed through the real chat pipeline. */
export async function runModelTest(
  connection: ConnectionOption,
  modelId: string
): Promise<ModelTestOutcome | null> {
  try {
    const res = await fetch("/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: connection.provider,
        modelId,
        connectionId: connection.id,
      }),
    });
    return toModelTestOutcome(res.status, await readJson(res));
  } catch {
    return null;
  }
}

/** Newest row of `GET /api/usage/call-logs` (an array, newest first). No request/response bodies. */
function toRecentRequest(body: unknown): RecentRequest | null {
  const rows = Array.isArray(body) ? body : asRecord(body)?.logs;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = asRecord(rows[0]);
  const model = readString(row, "model");
  if (!model) return null;
  return {
    model,
    status: toStatus(row?.status),
    timestamp: readString(row, "timestamp"),
  };
}

export async function loadRecentRequest(): Promise<
  { kind: "ok"; request: RecentRequest | null } | { kind: "error" }
> {
  try {
    const res = await fetch("/api/usage/call-logs?limit=5");
    if (!res.ok) return { kind: "error" };
    return { kind: "ok", request: toRecentRequest(await readJson(res)) };
  } catch {
    return { kind: "error" };
  }
}
