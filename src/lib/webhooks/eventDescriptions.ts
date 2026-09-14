export type WebhookEvent =
  | "request.completed"
  | "request.failed"
  | "quota.exceeded"
  | "slo.breached"
  | "slo.recovered"
  | "provider.circuit_open"
  | "test.ping";

export const WEBHOOK_EVENT_VALUES = [
  "request.completed",
  "request.failed",
  "quota.exceeded",
  "slo.breached",
  "slo.recovered",
  "provider.circuit_open",
  "test.ping",
] as const;

export interface EventDescription {
  label: string;
  description: string;
  emoji: string;
  exampleData: Record<string, unknown>;
}

export const EVENT_DESCRIPTIONS: Record<WebhookEvent, EventDescription> = {
  "request.completed": {
    label: "Request Completed",
    emoji: "✅",
    description: "Triggered when an upstream request completes successfully (HTTP 2xx).",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      latencyMs: 1240,
      tokensIn: 142,
      tokensOut: 38,
    },
  },
  "request.failed": {
    label: "Request Failed",
    emoji: "🚨",
    description: "Triggered when a request fails after all retries and fallback combo targets.",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      error: "503 Service Unavailable",
      attempts: 3,
    },
  },
  "quota.exceeded": {
    label: "Quota Exceeded",
    emoji: "📊",
    description: "A usage threshold (e.g. 95% of quota) was reached.",
    exampleData: { quota: "daily_tokens", used: 950000, limit: 1000000, pct: 95 },
  },
  "slo.breached": {
    label: "SLO Breached",
    emoji: "📉",
    description:
      "A configured service level objective (availability, latency, TTFT, error rate, failover success, provider recovery) crossed its threshold. Sent once per breach.",
    exampleData: {
      objective: "latency_p95",
      value: 42000,
      threshold: 30000,
      comparison: "max",
      windowMinutes: 15,
      samples: 180,
    },
  },
  "slo.recovered": {
    label: "SLO Recovered",
    emoji: "📈",
    description: "A previously breached service level objective is back within its threshold.",
    exampleData: {
      objective: "latency_p95",
      value: 12000,
      threshold: 30000,
      comparison: "max",
      windowMinutes: 15,
      samples: 210,
    },
  },
  "provider.circuit_open": {
    label: "Provider Circuit Open",
    emoji: "⛔",
    description:
      "A provider circuit breaker transitioned to OPEN (requests to it are short-circuited). Sent once per open cycle.",
    exampleData: { provider: "openai", failureCount: 5, retryAfterMs: 30000 },
  },
  "test.ping": {
    label: "Test Ping",
    emoji: "🏓",
    description: "Manual test delivery to verify your webhook is reachable.",
    exampleData: { message: "Test ping from OmniRoute", webhookId: "preview" },
  },
};
