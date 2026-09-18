import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { rankCandidates } from "@/lib/routing/adaptiveRouting";
import type { RoutingRequest } from "@/shared/contracts/routing";
import { DEFAULT_WEIGHTS } from "@omniroute/open-sse/services/autoCombo/scoring.ts";
import {
  previewRoutingDecision,
  type DecisionCandidateInput,
} from "@omniroute/open-sse/services/autoCombo/routingDecision.ts";

const candidateSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  capabilityScore: z.number().min(0).max(1),
  allocation: z.enum(["allow", "warn", "deny"]),
  healthScore: z.number().min(0).max(1),
  circuit: z.enum(["closed", "open", "half_open"]),
  quota: z.enum(["healthy", "approaching_limit", "exhausted", "unavailable", "unknown"]),
  latencyMs: z.number().nonnegative().optional(),
  errorRate: z.number().min(0).max(1).optional(),
  modelPreference: z.number().min(0).max(1).optional(),
  costPreference: z.number().min(0).max(1).optional(),
});

const requestSchema = z.object({ candidates: z.array(candidateSchema).min(1).max(100) });

const weight = z.number().min(0).optional();
const weightsSchema = z.object({
  quota: weight,
  health: weight,
  costInv: weight,
  latencyInv: weight,
  taskFit: weight,
  stability: weight,
  tierPriority: weight,
  tierAffinity: weight,
  specificityMatch: weight,
  contextAffinity: weight,
  cacheAffinity: weight,
  sessionAvailability: weight,
  resetWindowAffinity: weight,
  connectionDensity: weight,
  quality: weight,
  reliability: weight,
});

const unit = z.number().min(0).max(1);
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const autoCandidateSchema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  /** Remaining quota percentage; omitted means there is no quota signal ("unknown"). */
  quotaRemaining: z.number().min(0).max(100).optional(),
  quotaCutoffBlocked: z.boolean().optional(),
  modelAvailable: z.boolean().optional(),
  capabilities: z.array(z.string().max(64)).max(32).optional(),
  circuitBreakerState: z.enum(["CLOSED", "HALF_OPEN", "OPEN"]).optional(),
  costPer1MTokens: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  latencyStdDev: z.number().nonnegative().optional(),
  errorRate: unit.optional(),
  accountTier: z.enum(["ultra", "pro", "standard", "free"]).optional(),
  contextAffinity: unit.optional(),
  sessionAvailability: unit.optional(),
  quality: unit.optional(),
});

const autoRequestSchema = z.object({
  engine: z.literal("auto"),
  request: z
    .object({
      requestId: z.string().regex(SAFE_REQUEST_ID).optional(),
      model: z.string().min(1).max(256).optional(),
      protocol: z.string().min(1).max(64).optional(),
      capabilities: z.array(z.string().max(64)).max(32).optional(),
      stream: z.boolean().optional(),
      budget: z
        .object({
          maxCost: z.number().nonnegative().optional(),
          maxLatencyMs: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  policy: z
    .object({
      name: z.string().min(1).max(128).optional(),
      candidatePool: z.array(z.string().min(1).max(128)).max(100).optional(),
      weights: weightsSchema.optional(),
      modePack: z.string().min(1).max(64).optional(),
      budgetCap: z.number().positive().optional(),
      budgetFallback: z.enum(["cheapest", "strict"]).optional(),
      explorationRate: unit.optional(),
    })
    .optional(),
  taskType: z.string().min(1).max(64).optional(),
  candidates: z.array(autoCandidateSchema).min(1).max(100),
});

type AutoPreviewBody = z.infer<typeof autoRequestSchema>;

const MAX_REPORTED_ISSUES = 5;

/**
 * A readable 400 message: each problem as `field: message` (at most five), e.g.
 * `Invalid route preview request: candidates: Too small: expected array to have >=1 items`.
 */
function invalidBodyMessage(error: z.ZodError): string {
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const field = issue.path.map(String).join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - issues.length;
  const suffix = more > 0 ? ` (and ${more} more)` : "";
  return `Invalid route preview request: ${issues.join("; ")}${suffix}`;
}

function badRequest(message: string): Response {
  return NextResponse.json({ error: message }, { status: 400 });
}

function previewRequestId(body: AutoPreviewBody, request: Request): string {
  if (body.request?.requestId) return body.request.requestId;
  const header = request.headers.get("x-request-id");
  return header && SAFE_REQUEST_ID.test(header) ? header : `preview-${randomUUID()}`;
}

function toDecisionCandidate(
  candidate: AutoPreviewBody["candidates"][number]
): DecisionCandidateInput {
  return {
    ...candidate,
    quotaRemaining: candidate.quotaRemaining ?? 100,
    quotaKnown: candidate.quotaRemaining !== undefined,
    quotaTotal: 100,
    circuitBreakerState: candidate.circuitBreakerState ?? "CLOSED",
    latencyStdDev: candidate.latencyStdDev ?? Math.max(10, candidate.p95LatencyMs * 0.1),
    errorRate: candidate.errorRate ?? 0,
  };
}

function previewAuto(body: AutoPreviewBody, request: Request): Response {
  const routingRequest: RoutingRequest = {
    requestId: previewRequestId(body, request),
    model: body.request?.model ?? "auto",
    protocol: body.request?.protocol ?? "openai-chat",
    capabilities: body.request?.capabilities,
    stream: body.request?.stream,
    budget: body.request?.budget,
  };
  const policy = body.policy ?? {};
  const name = policy.name ?? "route-preview";
  const decision = previewRoutingDecision({
    request: routingRequest,
    config: {
      id: name,
      name,
      type: "auto",
      candidatePool: policy.candidatePool ?? [],
      weights: { ...DEFAULT_WEIGHTS, ...policy.weights },
      modePack: policy.modePack,
      budgetCap: policy.budgetCap,
      budgetFallback: policy.budgetFallback,
      explorationRate: policy.explorationRate ?? 0,
    },
    candidates: body.candidates.map(toDecisionCandidate),
    taskType: body.taskType,
  });
  return NextResponse.json(
    {
      request: { candidateCount: body.candidates.length },
      selected: decision.selected?.providerId ?? null,
      candidates: decision.candidates,
      liveRequestExecuted: false,
      decision,
    },
    {
      headers: {
        "x-request-id": routingRequest.requestId,
        "x-omniroute-decision-id": decision.decisionId,
      },
    }
  );
}

/**
 * Deterministic routing preview. It never calls an upstream provider.
 *
 * `{ candidates }` keeps the original adaptive what-if ranking. `{ engine: "auto", candidates }`
 * runs the live auto-combo selection engine on the supplied candidates (no exploration, no change
 * to routing state) and returns the full `RoutingDecision`: scores, factors, exclusion reasons,
 * quota and circuit state, estimated cost and latency, and the policy version.
 */
export async function POST(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const raw: unknown = await request.json().catch(() => null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return badRequest("Invalid route preview request: the body must be a JSON object");
  }

  if ("engine" in raw) {
    const auto = autoRequestSchema.safeParse(raw);
    if (!auto.success) return badRequest(invalidBodyMessage(auto.error));
    return previewAuto(auto.data, request);
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return badRequest(invalidBodyMessage(parsed.error));

  const result = rankCandidates(parsed.data.candidates);
  return NextResponse.json({
    request: { candidateCount: parsed.data.candidates.length },
    ...result,
    selected: result.selected?.providerId ?? null,
    liveRequestExecuted: false,
  });
}
