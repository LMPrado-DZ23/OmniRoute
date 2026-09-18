/**
 * Request/response types for the endpoints the SDK covers. Shapes follow docs/openapi.yaml;
 * every object keeps an index signature so fields the server adds later pass through untouched.
 */

export type ChatRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "function"
  | "developer"
  | (string & {});

export interface ChatMessage {
  role: ChatRole;
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  /** Controlled by the SDK: `create` sends `false`, `stream` sends `true`. */
  stream?: never;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: string; content: string | null; [key: string]: unknown };
  finish_reason: string | null;
  [key: string]: unknown;
}

export interface ChatCompletion {
  id: string;
  object: string;
  created?: number;
  model?: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  [key: string]: unknown;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: { role?: string; content?: string | null; [key: string]: unknown };
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  model?: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage | null;
  [key: string]: unknown;
}

export interface Model {
  id: string;
  object?: string;
  owned_by?: string;
  [key: string]: unknown;
}

export interface ModelList {
  object: string;
  data: Model[];
  [key: string]: unknown;
}

/** GET /api/health — unauthenticated liveness probe. */
export interface HealthStatus {
  status: "ok" | (string & {});
  timestamp: string;
  [key: string]: unknown;
}

/** GET /api/v1/me/status — usage/quota of the calling API key (requires the `self:usage` scope). */
export interface ApiKeyStatus {
  apiKey: { id: string; name?: string | null; [key: string]: unknown };
  usage: {
    cost: Record<string, unknown>;
    tokens: Record<string, unknown>;
    [key: string]: unknown;
  };
  accountQuotas?: Array<Record<string, unknown>>;
  accountQuota?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoutingCandidate {
  providerId: string;
  modelId: string;
  capabilityScore: number;
  allocation: "allow" | "warn" | "deny";
  healthScore: number;
  circuit: "closed" | "open" | "half_open";
  quota: "healthy" | "approaching_limit" | "exhausted" | "unavailable" | "unknown";
  latencyMs?: number;
  errorRate?: number;
  modelPreference?: number;
  costPreference?: number;
  [key: string]: unknown;
}

export interface RoutePreviewRequest {
  candidates: RoutingCandidate[];
  [key: string]: unknown;
}

export interface RoutingExplanation {
  providerId: string;
  modelId: string;
  score: number;
  eligible: boolean;
  reasons: string[];
  factors: Record<string, number | string>;
  [key: string]: unknown;
}

/** POST /api/omniroute/route/preview — deterministic ranking; never calls a provider. */
export interface RoutePreviewResult {
  request: { candidateCount: number; [key: string]: unknown };
  selected: string | null;
  candidates: RoutingExplanation[];
  liveRequestExecuted: false;
  [key: string]: unknown;
}

/** Every non-streaming call resolves to the decoded body plus correlation metadata. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  /** `x-request-id` returned by the server, or `clientRequestId` when the response has none. */
  requestId: string;
  /** The `x-request-id` the SDK sent. */
  clientRequestId: string;
  headers: Headers;
}
