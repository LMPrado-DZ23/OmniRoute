/**
 * Request context for client API routes that the router can serve through a combo.
 *
 * The authz pipeline stamps `x-request-id` on every forwarded request and on the response. Running
 * the handler inside that id's async context lets the router record its decision under the same
 * id the client receives, so a request can be explained later by its request id. Non-streaming
 * responses also carry the decision id and policy version; streaming responses are sent before
 * routing finishes, so their decision is found through the lookup endpoint instead.
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
