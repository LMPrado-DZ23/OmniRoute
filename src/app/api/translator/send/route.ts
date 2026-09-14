import { NextResponse } from "next/server";
import {
  buildProviderUrl,
  buildProviderHeaders,
  detectFormat,
  getTargetFormat,
} from "@omniroute/open-sse/services/provider.ts";
import { getProviderConnections } from "@/lib/db/providers";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { logTranslationEvent } from "@/lib/translatorEvents";
import { translatorSendSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { guardedFetch } from "@/shared/network/guardedFetch";
import { OutboundUrlGuardError } from "@/shared/network/outboundUrlGuard";
import { areIntegrationPrivateUrlsAllowed } from "@/shared/network/outboundUrlGuardPolicy";

/** Bound on the time to response headers for the forwarded provider request. */
const PROVIDER_SEND_TIMEOUT_MS = 120_000;

/** Connection rows are Record<string, unknown>; providerSpecificData is an object or absent. */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProviderBaseUrl(providerSpecificData: unknown): string | undefined {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return undefined;
  const baseUrl = (providerSpecificData as Record<string, unknown>).baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl : undefined;
}

/** Request facts every translation event of one forwarded send shares. */
type SendOutcomeContext = {
  provider: string;
  body: Record<string, unknown>;
  sourceFormat: ReturnType<typeof detectFormat>;
  targetFormat: ReturnType<typeof getTargetFormat>;
  startedAt: number;
};

/** Records the outcome of the forwarded send as a translation event (latency measured here). */
function logSendOutcome(
  { provider, body, sourceFormat, targetFormat, startedAt }: SendOutcomeContext,
  status: "success" | "error",
  statusCode: number
) {
  logTranslationEvent({
    provider,
    model: body.model || "test-model",
    sourceFormat,
    targetFormat,
    status,
    statusCode,
    latency: Date.now() - startedAt,
    endpoint: "/api/translator/send",
  });
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const startedAt = Date.now();
    const validation = validateBody(translatorSendSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const { provider, body } = validation.data;

    const sourceFormat = detectFormat(body);
    let targetFormat = getTargetFormat(provider);

    // Get provider credentials from database
    const connections = await getProviderConnections({ provider });
    const connection = (
      await Promise.all(
        connections.map(async (candidate) => ({
          candidate,
          blocked: await isConnectionUnavailableToAuxiliaryActivity(
            typeof candidate.id === "string" ? candidate.id : ""
          ),
        }))
      )
    ).find(({ candidate, blocked }) => candidate.isActive !== false && !blocked)?.candidate;

    if (!connection) {
      logSendOutcome({ provider, body, sourceFormat, targetFormat, startedAt }, "error", 400);
      return NextResponse.json(
        {
          success: false,
          error: `No active connection found for provider: ${provider}. Available connections: ${connections.length}`,
        },
        { status: 400 }
      );
    }

    const credentials = {
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      copilotToken: connection.copilotToken,
      projectId: connection.projectId,
      providerSpecificData: connection.providerSpecificData,
    };
    targetFormat = getTargetFormat(provider, connection.providerSpecificData);

    // Build URL and headers using provider service
    const url = buildProviderUrl(provider, body.model || "test-model", true, {
      baseUrlIndex: 0,
      baseUrl: getProviderBaseUrl(connection.providerSpecificData),
      providerSpecificData: isObjectValue(connection.providerSpecificData)
        ? connection.providerSpecificData
        : null,
    });
    const headers = buildProviderHeaders(provider, credentials, true, body);

    // Send request to provider. SSRF S-6: for OpenAI-compatible connections the base URL is
    // operator data (providerSpecificData.baseUrl) — resolved address validated (cloud
    // metadata never; private/LAN under the local-first provider policy), connection pinned,
    // redirects never followed. A guard decision is a configuration error, reported URL-free.
    let response: Response;
    try {
      response = await guardedFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs: PROVIDER_SEND_TIMEOUT_MS,
        allowPrivate: areIntegrationPrivateUrlsAllowed(),
      });
    } catch (error) {
      if (error instanceof OutboundUrlGuardError) {
        logSendOutcome({ provider, body, sourceFormat, targetFormat, startedAt }, "error", 400);
        return NextResponse.json(
          { success: false, error: "Provider base URL blocked by the outbound guard" },
          { status: 400 }
        );
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const normalizedUpstreamError = toJsonErrorPayload(
        errorText,
        `Provider error: ${response.status} ${response.statusText}`
      );
      logSendOutcome(
        { provider, body, sourceFormat, targetFormat, startedAt },
        "error",
        response.status
      );
      return NextResponse.json(
        {
          success: false,
          error:
            normalizedUpstreamError.error?.message ||
            `Provider error: ${response.status} ${response.statusText}`,
          details: normalizedUpstreamError,
        },
        { status: response.status }
      );
    }

    logSendOutcome({ provider, body, sourceFormat, targetFormat, startedAt }, "success", 200);

    // Return streaming response
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error sending request:", error);
    return NextResponse.json({ success: false, error: "Failed to send request" }, { status: 500 });
  }
}
