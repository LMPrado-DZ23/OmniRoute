/**
 * Audit C H1 — API side of the webhook wizard fix.
 *
 * - POST /api/webhooks accepts an optional `enabled` (default true, so the existing contract
 *   is unchanged). The dashboard wizard creates its step-2 draft with `enabled:false`, so an
 *   abandoned wizard can never leave an active all-events webhook behind.
 * - Rejected events come back in the validation envelope, and the shared
 *   `describeApiError` turns that envelope into readable text (not `[object Object]`).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-webhook-draft-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
await updateSettings({ requireLogin: false });

const webhooksRoute = await import("../../src/app/api/webhooks/route.ts");
const { getWebhook, getEnabledWebhooks } = await import("../../src/lib/db/webhooks.ts");
const { describeApiError } = await import("../../src/shared/utils/apiErrorPresentation.ts");

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function post(body: unknown): Promise<Response> {
  return webhooksRoute.POST(
    new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/webhooks — optional enabled flag", () => {
  it("creates a disabled webhook when enabled:false (wizard draft)", async () => {
    const res = await post({
      url: "https://hooks.example.com/draft",
      kind: "custom",
      events: ["slo.breached"],
      enabled: false,
    });
    assert.equal(res.status, 201);
    const { webhook } = await res.json();
    assert.equal(webhook.enabled, false);
    assert.deepEqual(webhook.events, ["slo.breached"]);
    assert.equal(getWebhook(webhook.id)?.enabled, false);
    assert.equal(
      getEnabledWebhooks().some((w) => w.id === webhook.id),
      false,
      "a draft must never be picked up by the dispatcher"
    );
  });

  it("keeps the historical default: omitted enabled → enabled webhook", async () => {
    const res = await post({ url: "https://hooks.example.com/default", kind: "custom" });
    assert.equal(res.status, 201);
    const { webhook } = await res.json();
    assert.equal(webhook.enabled, true);
    assert.deepEqual(webhook.events, ["*"]);
  });

  it("accepts every new SLO/circuit event", async () => {
    const res = await post({
      url: "https://hooks.example.com/slo",
      kind: "custom",
      events: [
        "slo.breached",
        "slo.recovered",
        "provider.circuit_open",
        "budget.threshold_reached",
      ],
    });
    assert.equal(res.status, 201);
  });

  it("rejects a non-boolean enabled", async () => {
    const res = await post({ url: "https://hooks.example.com/x", kind: "custom", enabled: "no" });
    assert.equal(res.status, 400);
  });
});

describe("describeApiError — readable validation errors", () => {
  it("renders the rejected-event envelope as text naming the field", async () => {
    const res = await post({
      url: "https://hooks.example.com/ghost",
      kind: "custom",
      events: ["provider.error"],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    const text = describeApiError(body, "Failed to save", res.status);
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.match(text, /^Invalid request: events\.0: /);
    assert.match(text, /slo\.breached/, "the message lists the accepted events");
  });

  it("passes a plain string error through", () => {
    assert.equal(
      describeApiError({ error: "Webhook not found" }, "Failed", 404),
      "Webhook not found"
    );
  });

  it("falls back when the body carries nothing usable", () => {
    assert.equal(describeApiError({}, "Failed to save"), "Failed to save");
    assert.equal(describeApiError(null, "Failed to save"), "Failed to save");
  });

  it("ignores malformed details entries", () => {
    const text = describeApiError(
      {
        error: {
          message: "Invalid request",
          details: [null, { field: "url" }, { message: "bad" }],
        },
      },
      "Failed"
    );
    assert.equal(text, "Invalid request: bad");
  });
});
