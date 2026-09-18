/**
 * Request context for client API routes that the router can serve through a combo.
 *
 * The authz pipeline stamps `x-request-id` on every forwarded request and on the response. Running
 * the handler inside that id's async context lets the router record its decision under the same
 * id the client receives, so a request can be explained later by its request id. The response
 * also carries the decision id and policy version whenever a decision was recorded before the
 * handler returned its Response. That is the normal case for streaming responses too: the target
 * is chosen before the stream starts. The headers are missing when no decision was recorded (a
 * combo strategy other than `auto`, a direct model) or when the Response headers are immutable;
 * the lookup endpoint by request id works in every case while the decision is retained.
 *
 * Only opaque identifiers leave through these headers: never provider credentials, prompts or
 * account ids.
 */
import { getRoutingDecision } from "@omniroute/open-sse/services/routing/decisionStore.ts";
import { getRequestId, withRequestId } from "@/shared/utils/requestId";

const DECISION_ID_HEADER = "X-OmniRoute-Decision-Id";
const POLICY_VERSION_HEADER = "X-OmniRoute-Policy-Version";

/** Add the decision id and policy version recorded for `requestId`, when there is one. */
export function attachRoutingDecisionHeaders(
  response: Response,
  requestId: string | null
): Response {
  if (!requestId) return response;
  const decision = getRoutingDecision(requestId);
  if (!decision || decision.requestId !== requestId) return response;
  try {
    response.headers.set(DECISION_ID_HEADER, decision.decisionId);
    response.headers.set(POLICY_VERSION_HEADER, decision.policyVersion);
  } catch {
    // Immutable headers (an opaque upstream Response): the decision stays available through
    // GET /api/omniroute/route/decisions/{requestId}.
  }
  return response;
}

type RouteHandler<Rest extends unknown[]> = (
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>;

export function withRoutingRequestContext<Rest extends unknown[]>(
  handler: RouteHandler<Rest>
): (request: Request, ...rest: Rest) => Promise<Response> {
  return (request, ...rest) =>
    withRequestId(request, async () => {
      const response = await handler(request, ...rest);
      return attachRoutingDecisionHeaders(response, getRequestId());
    });
}
