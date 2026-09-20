/**
 * The two base-URL forms a CLI card can hand to a tool.
 *
 * Most catalog entries want the OpenAI-compatible base — the gateway origin plus
 * `/v1` — because the client appends only `/chat/completions` to it. That is what
 * `{{baseUrl}}` renders.
 *
 * A second family of clients appends its OWN versioned path to whatever base it is
 * given, so handing them the `/v1` form produces a doubled prefix and a 404:
 *
 *   - `@google/genai` (Gemini CLI) builds `{base}/v1beta/models/{model}:generateContent`
 *   - Goose joins `OPENAI_HOST` with `OPENAI_BASE_PATH` (`v1/chat/completions`)
 *   - Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL`
 *
 * Those want the origin, which is what `{{baseOrigin}}` renders. The distinction is
 * a property of the client, not of the gateway: OmniRoute serves `/v1/...` and
 * `/v1beta/...` off the same origin.
 *
 * Both helpers are total and side-effect free so the composition can be asserted in
 * tests without rendering a card.
 */

const V1_SUFFIX = "/v1";

/** Strip trailing slashes. Kept private so both forms normalize identically. */
function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * The OpenAI-compatible base: origin + `/v1`, added only when not already present.
 * This is the value behind `{{baseUrl}}`.
 */
export function toGatewayV1Url(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  if (!trimmed) return trimmed;
  return trimmed.endsWith(V1_SUFFIX) ? trimmed : `${trimmed}${V1_SUFFIX}`;
}

/**
 * The gateway origin, with any `/v1` suffix removed. This is the value behind
 * `{{baseOrigin}}`, for clients that append their own versioned path.
 */
export function toGatewayOriginUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  if (!trimmed.endsWith(V1_SUFFIX)) return trimmed;
  return trimTrailingSlashes(trimmed.slice(0, -V1_SUFFIX.length));
}
