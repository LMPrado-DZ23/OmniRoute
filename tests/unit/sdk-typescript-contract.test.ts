/**
 * Runs the shared SDK contract fixtures (sdk/contract/fixtures/*.json) against the TypeScript SDK
 * through an in-process fake fetch. The Python SDK runs the same fixtures in
 * sdk/python/tests/test_contract.py. No network access, no provider calls.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPERATIONS,
  OmniRouteClient,
  OmniRouteError,
  type ChatCompletionRequest,
  type FetchLike,
  type OperationName,
  type RetryOptions,
  type RoutePreviewRequest,
} from "../../sdk/typescript/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "sdk", "contract", "fixtures");
const BASE_URL = "http://omniroute.contract.test";

const FIXTURE_OPERATION_TO_SDK: Record<string, OperationName> = {
  chatCompletions: "chatCompletions",
  chatCompletionsStream: "chatCompletions",
  listModels: "listModels",
  health: "health",
  quota: "quota",
  routePreview: "routePreview",
};

interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  sse?: string;
  text?: string;
}

interface ExpectedRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  absentHeaders?: string[];
  body?: unknown;
}

interface ExpectedResult {
  status: number;
  requestId: string;
  clientRequestId: string;
  data?: unknown;
}

interface ContractCase {
  name: string;
  operation: string;
  client: { apiKey?: string; managementKey?: string; requestId: string; retry: RetryOptions };
  input?: Record<string, unknown>;
  expectedRequests: ExpectedRequest[];
  responses: FixtureResponse[];
  expectedDelaysMs?: number[];
  expected: { result?: ExpectedResult; chunks?: unknown[]; error?: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertContractCase(value: unknown, file: string): asserts value is ContractCase {
  assert.ok(isRecord(value), `${file}: every case must be an object`);
  assert.equal(typeof value.name, "string", `${file}: case.name`);
  assert.equal(typeof value.operation, "string", `${file}: case.operation`);
  assert.ok(
    isRecord(value.client) &&
      typeof value.client.requestId === "string" &&
      isRecord(value.client.retry),
    `${file}: ${String(value.name)} needs client.requestId and client.retry`
  );
  assert.ok(
    Array.isArray(value.expectedRequests) &&
      value.expectedRequests.every(
        (request) =>
          isRecord(request) &&
          typeof request.method === "string" &&
          typeof request.path === "string"
      ),
    `${file}: ${String(value.name)} expectedRequests`
  );
  assert.ok(
    Array.isArray(value.responses) &&
      value.responses.every(
        (response) => isRecord(response) && typeof response.status === "number"
      ),
    `${file}: ${String(value.name)} responses`
  );
  assert.ok(
    isRecord(value.expected) &&
      (value.expected.result !== undefined || value.expected.error !== undefined),
    `${file}: ${String(value.name)} expected.result or expected.error`
  );
}

function loadFixtureCases(): Array<{ file: string; testCase: ContractCase }> {
  const loaded: Array<{ file: string; testCase: ContractCase }> = [];
  for (const file of readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const document: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    assert.ok(isRecord(document) && Array.isArray(document.cases), `${file}: needs a cases array`);
    for (const testCase of document.cases) {
      assertContractCase(testCase, file);
      loaded.push({ file, testCase });
    }
  }
  return loaded;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string | undefined;
}

function createFakeFetch(responses: readonly FixtureResponse[]): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error("fake fetch: no response queued");
    const body =
      next.sse ?? (next.json !== undefined ? JSON.stringify(next.json) : (next.text ?? ""));
    return new Response(body, { status: next.status, headers: next.headers });
  };
  return { fetch, requests };
}

function assertChatRequest(input: unknown): asserts input is ChatCompletionRequest {
  assert.ok(
    isRecord(input) && typeof input.model === "string" && Array.isArray(input.messages),
    "chat fixtures need input.model and input.messages"
  );
}

function assertRoutePreviewRequest(input: unknown): asserts input is RoutePreviewRequest {
  assert.ok(
    isRecord(input) && Array.isArray(input.candidates),
    "route preview fixtures need input.candidates"
  );
}

interface Outcome {
  result?: ExpectedResult;
  chunks: unknown[];
  error?: unknown;
}

async function invoke(client: OmniRouteClient, testCase: ContractCase): Promise<Outcome> {
  const chunks: unknown[] = [];
  const meta = (response: {
    status: number;
    requestId: string;
    clientRequestId: string;
    data: unknown;
  }) => ({
    status: response.status,
    requestId: response.requestId,
    clientRequestId: response.clientRequestId,
    data: response.data,
  });
  try {
    switch (testCase.operation) {
      case "chatCompletions": {
        assertChatRequest(testCase.input);
        return { result: meta(await client.chat.completions.create(testCase.input)), chunks };
      }
      case "chatCompletionsStream": {
        assertChatRequest(testCase.input);
        const stream = await client.chat.completions.stream(testCase.input);
        for await (const chunk of stream) chunks.push(chunk);
        return {
          result: {
            status: stream.status,
            requestId: stream.requestId,
            clientRequestId: stream.clientRequestId,
          },
          chunks,
        };
      }
      case "listModels":
        return { result: meta(await client.models.list()), chunks };
      case "health":
        return { result: meta(await client.health()), chunks };
      case "quota":
        return { result: meta(await client.quota()), chunks };
      case "routePreview": {
        assertRoutePreviewRequest(testCase.input);
        return { result: meta(await client.routing.preview(testCase.input)), chunks };
      }
      default:
        assert.fail(`unknown fixture operation: ${testCase.operation}`);
    }
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    return { chunks, error };
  }
}

function errorField(error: OmniRouteError, key: string): unknown {
  switch (key) {
    case "status":
      return error.status;
    case "message":
      return error.message;
    case "code":
      return error.code;
    case "type":
      return error.type;
    case "reason":
      return error.reason;
    case "requestId":
      return error.requestId;
    case "retryAfterMs":
      return error.retryAfterMs;
    default:
      return assert.fail(`unknown expected error field: ${key}`);
  }
}

async function runCase(testCase: ContractCase): Promise<void> {
  const fake = createFakeFetch(testCase.responses);
  const delays: number[] = [];
  const client = new OmniRouteClient({
    baseUrl: BASE_URL,
    apiKey: testCase.client.apiKey,
    managementKey: testCase.client.managementKey,
    retry: testCase.client.retry,
    fetch: fake.fetch,
    requestIdFactory: () => testCase.client.requestId,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  const outcome = await invoke(client, testCase);

  assert.equal(fake.requests.length, testCase.expectedRequests.length, "request count");
  testCase.expectedRequests.forEach((expected, index) => {
    const recorded = fake.requests[index];
    assert.ok(recorded, `request #${index} was not sent`);
    assert.equal(recorded.method, expected.method, `request #${index} method`);
    const url = new URL(recorded.url);
    assert.equal(url.origin, BASE_URL);
    assert.equal(url.pathname, expected.path, `request #${index} path`);
    for (const [name, value] of Object.entries(expected.headers ?? {})) {
      assert.equal(recorded.headers.get(name), value, `request #${index} header ${name}`);
    }
    for (const name of expected.absentHeaders ?? []) {
      assert.equal(recorded.headers.get(name), null, `request #${index} must not send ${name}`);
    }
    if ("body" in expected) {
      if (expected.body === null) assert.equal(recorded.body, undefined, `request #${index} body`);
      else {
        assert.ok(recorded.body !== undefined, `request #${index} body missing`);
        assert.deepEqual(JSON.parse(recorded.body), expected.body, `request #${index} body`);
      }
    }
  });

  assert.deepEqual(delays, testCase.expectedDelaysMs ?? [], "backoff delays");

  const { expected } = testCase;
  if (expected.chunks !== undefined) assert.deepEqual(outcome.chunks, expected.chunks, "chunks");

  if (expected.error !== undefined) {
    assert.ok(
      outcome.error instanceof OmniRouteError,
      `expected OmniRouteError, got ${String(outcome.error)}`
    );
    for (const [key, value] of Object.entries(expected.error)) {
      assert.equal(
        errorField(outcome.error, key),
        value === null ? undefined : value,
        `error.${key}`
      );
    }
    return;
  }

  assert.equal(outcome.error, undefined, `unexpected error: ${String(outcome.error)}`);
  assert.ok(outcome.result && expected.result, "result");
  assert.equal(outcome.result.status, expected.result.status, "result.status");
  assert.equal(outcome.result.requestId, expected.result.requestId, "result.requestId");
  assert.equal(
    outcome.result.clientRequestId,
    expected.result.clientRequestId,
    "result.clientRequestId"
  );
  if (expected.result.data !== undefined) {
    assert.deepEqual(outcome.result.data, expected.result.data, "result.data");
  }
}

const cases = loadFixtureCases();

describe("SDK contract fixtures: coverage", () => {
  it("loads at least one case per SDK operation", () => {
    const covered = new Set<string>(
      cases.map(({ testCase }) => FIXTURE_OPERATION_TO_SDK[testCase.operation] ?? "unknown")
    );
    for (const name of Object.keys(OPERATIONS)) {
      assert.ok(covered.has(name), `no fixture covers ${name}`);
    }
  });

  it("every fixture request targets the operation's method and path", () => {
    for (const { file, testCase } of cases) {
      const sdkOperation = FIXTURE_OPERATION_TO_SDK[testCase.operation];
      assert.ok(sdkOperation, `${file}: unknown operation ${testCase.operation}`);
      const spec = OPERATIONS[sdkOperation];
      for (const request of testCase.expectedRequests) {
        assert.equal(request.method, spec.method, `${file}: ${testCase.name}`);
        assert.equal(request.path, spec.path, `${file}: ${testCase.name}`);
      }
    }
  });
});

for (const { file, testCase } of cases) {
  describe(`SDK contract (TypeScript): ${file}`, () => {
    it(testCase.name, () => runCase(testCase));
  });
}
