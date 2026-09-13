/**
 * Finding F-6 (media routes): POST /v1/music/generations, /v1/videos/generations,
 * /v1/audio/transcriptions and /v1/audio/translations checked the credential lookup only for
 * `allRateLimited`. When every connection of the provider is in a terminal state, the lookup returns
 * `{ allExpired: true, expiredCount, expiredStatus }`, which the routes passed on as if it were
 * credentials. The chat path answers 401 (402 for credits_exhausted) with a reconnect hint; these
 * routes must answer the same way and never reach the upstream provider. Upstream fetches are
 * captured by a stub, so nothing leaves the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-media-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "media-expired-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");
const musicRoute = await import("../../src/app/api/v1/music/generations/route.ts");
const videoRoute = await import("../../src/app/api/v1/videos/generations/route.ts");
const transcriptionRoute = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
const translationRoute = await import("../../src/app/api/v1/audio/translations/route.ts");

const originalFetch = globalThis.fetch;
let upstreamCalls: string[] = [];

async function resetStorage() {
  upstreamCalls = [];
  globalThis.fetch = async (url) => {
    upstreamCalls.push(String(url));
    return new Response(JSON.stringify({ error: { message: "stubbed upstream" } }), {
      status: 500,
    });
  };
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedTerminalConnection(provider: string, testStatus: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${testStatus}`,
    apiKey: `sk-${provider}-${testStatus}-${Math.random().toString(16).slice(2, 10)}`,
    isActive: true,
    testStatus,
    backoffLevel: 4,
    providerSpecificData: {},
  });
  const credentials = await auth.getProviderCredentials(provider);
  assert.equal(
    credentials?.allExpired,
    true,
    `precondition: a ${testStatus} ${provider} pool makes the credential lookup report allExpired`
  );
  upstreamCalls = [];
}

/** Minimal but structurally valid WAV so nothing rejects the upload shape. */
function makeWav(): Blob {
  const dataLen = 1600;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  return new Blob([b], { type: "audio/wav" });
}

function audioRequest(url: string, model: string) {
  const fd = new FormData();
  fd.set("model", model);
  fd.set("file", makeWav(), "clip.wav");
  return new Request(url, { method: "POST", body: fd });
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CASES = [
  { status: "expired", httpStatus: 401, reason: /authentication expired/ },
  { status: "banned", httpStatus: 401, reason: /banned by upstream/ },
  { status: "credits_exhausted", httpStatus: 402, reason: /credits exhausted/ },
] as const;

const ROUTES = [
  {
    label: "music generation",
    provider: "fal-ai",
    call: () =>
      musicRoute.POST(
        jsonRequest("http://localhost/api/v1/music/generations", {
          model: "fal-ai/ace-step",
          prompt: "a calm piano melody",
        })
      ),
  },
  {
    label: "video generation",
    provider: "fal-ai",
    call: () =>
      videoRoute.POST(
        jsonRequest("http://localhost/api/v1/videos/generations", {
          model: "fal-ai/veo3.1/lite",
          prompt: "a sunset over the sea",
        })
      ),
  },
  {
    label: "audio transcription",
    provider: "openai",
    call: () =>
      transcriptionRoute.POST(
        audioRequest("http://localhost/api/v1/audio/transcriptions", "openai/whisper-1")
      ),
  },
  {
    label: "audio translation",
    provider: "openai",
    call: () =>
      translationRoute.POST(
        audioRequest("http://localhost/api/v1/audio/translations", "openai/whisper-1")
      ),
  },
] as const;

for (const route of ROUTES) {
  for (const { status, httpStatus, reason } of CASES) {
    test(`${route.label} answers ${httpStatus} without calling upstream when every connection is ${status}`, async () => {
      await seedTerminalConnection(route.provider, status);

      const res = await route.call();

      assert.equal(res.status, httpStatus, `Expected ${httpStatus}, got ${res.status}`);
      const body = await res.json();
      assert.match(String(body.error?.message), reason);
      assert.match(String(body.error?.message), /reconnect/);
      assert.deepEqual(upstreamCalls, [], "no request may reach the upstream provider");
    });
  }
}
