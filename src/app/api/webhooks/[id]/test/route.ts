/**
 * API: Webhook Test Delivery
 * POST — Send a test ping event to a specific webhook and return full diagnostics.
 */

import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getWebhook, recordWebhookDelivery } from "@/lib/db/webhooks";
import { decryptMetadata } from "@/lib/webhookDispatcher";
import { buildSlackPayload } from "@/lib/webhooks/integrations/slack";
import { buildTelegramUrl, buildTelegramPayload } from "@/lib/webhooks/integrations/telegram";
import { buildDiscordPayload } from "@/lib/webhooks/integrations/discord";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { insertDelivery } from "@/lib/db/webhookDeliveries";
import { hardenedWebhookFetch } from "@/shared/network/hardenedWebhookFetch";
import { arePrivateProviderUrlsAllowed } from "@/shared/network/outboundUrlGuardPolicy";
import crypto from "crypto";

const MAX_RESPONSE_BODY = 2048;

async function testFetch(
  url: string,
  body: object,
  headers: Record<string, string>
): Promise<{
  success: boolean;
  status: number;
  latencyMs: number;
  responseBody: string;
  error?: string;
}> {
  const start = Date.now();
  try {
    // Hardened path (SSRF #1): resolves + validates every resolved ip, pins the connection to the
    // validated ip (no DNS rebinding), never follows redirects, and never returns the body of a
    // private target. Private/LAN targets are reachable only under the explicit opt-in.
    const result = await hardenedWebhookFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeoutMs: 10_000,
      allowPrivate: arePrivateProviderUrlsAllowed(),
      maxBodyBytes: MAX_RESPONSE_BODY,
    });
    return {
      success: result.ok,
      status: result.status,
      latencyMs: Date.now() - start,
      responseBody: result.isPrivateTarget ? "<redacted: private target>" : result.bodyText,
    };
  } catch (error: any) {
    return {
      success: false,
      status: 0,
      latencyMs: Date.now() - start,
      responseBody: "",
      error: error.message || "Network error",
    };
  }
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(_);
  if (authError) return authError;

  try {
    const { id } = await params;
    const webhook = getWebhook(id);
    if (!webhook) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    const kind = webhook.kind ?? "custom";
    const testData = {
      message: "Test webhook delivery from OmniRoute",
      webhookId: webhook.id,
    };
    const testPayload = { event: "test.ping", timestamp: new Date().toISOString(), data: testData };

    let payloadSent: object;
    let fetchUrl: string;
    let extraHeaders: Record<string, string> = {};

    if (kind === "slack") {
      payloadSent = buildSlackPayload("test.ping", testData);
      fetchUrl = webhook.url;
    } else if (kind === "discord") {
      payloadSent = buildDiscordPayload("test.ping", testData);
      fetchUrl = webhook.url;
    } else if (kind === "telegram") {
      const meta = decryptMetadata(webhook.metadata_encrypted ?? null);
      const botToken = meta?.botToken;
      if (!botToken) {
        return NextResponse.json({ error: "Missing Telegram botToken" }, { status: 422 });
      }
      fetchUrl = buildTelegramUrl(botToken);
      payloadSent = buildTelegramPayload("test.ping", testData, webhook.url);
    } else {
      payloadSent = testPayload;
      fetchUrl = webhook.url;
      if (webhook.secret) {
        const bodyStr = JSON.stringify(testPayload);
        extraHeaders["X-Webhook-Signature"] =
          `sha256=${crypto.createHmac("sha256", webhook.secret).update(bodyStr).digest("hex")}`;
        extraHeaders["X-Webhook-Event"] = "test.ping";
        extraHeaders["X-Webhook-Timestamp"] = testPayload.timestamp;
      }
    }

    const result = await testFetch(fetchUrl, payloadSent, extraHeaders);

    try {
      insertDelivery({
        webhookId: webhook.id,
        eventType: "test.ping",
        status: result.success ? "success" : "failed",
        httpStatus: result.status || null,
        latencyMs: result.latencyMs,
        error: result.error ?? null,
        payloadSnapshot: kind === "custom" ? JSON.stringify(payloadSent).slice(0, 2000) : null,
      });
    } catch {
      // delivery logging is best-effort
    }
    recordWebhookDelivery(webhook.id, result.status, result.success);

    return NextResponse.json({
      delivered: result.success,
      status: result.status,
      latencyMs: result.latencyMs,
      payloadSent,
      responseBody: result.responseBody,
      error: result.error ? sanitizeErrorMessage(result.error) : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
