---
title: "SDKs (experimental)"
lastUpdated: 2026-09-18
---

# SDKs (experimental)

OmniRoute ships two minimal client SDKs in the repository. Both are **experimental and unpublished**: they are not on npm or PyPI, their API may change without notice, and they are consumed from source.

| SDK        | Location                                           | Runtime                           | Dependencies                     |
| ---------- | -------------------------------------------------- | --------------------------------- | -------------------------------- |
| TypeScript | [`sdk/typescript`](../../sdk/typescript/README.md) | Node.js 22+ (global `fetch`), ESM | none                             |
| Python     | [`sdk/python`](../../sdk/python/README.md)         | Python 3.9+                       | none (standard library `urllib`) |

Both SDKs expose the same surface and are verified against the same contract fixtures in `sdk/contract/fixtures/`.

## Endpoint coverage

| Capability    | Method and path                     | TypeScript                  | Python                      | Credential                                 |
| ------------- | ----------------------------------- | --------------------------- | --------------------------- | ------------------------------------------ |
| Chat          | `POST /api/v1/chat/completions`     | `chat.completions.create()` | `chat_completions()`        | client API key                             |
| Streaming     | `POST /api/v1/chat/completions`     | `chat.completions.stream()` | `stream_chat_completions()` | client API key                             |
| Models        | `GET /api/v1/models`                | `models.list()`             | `list_models()`             | client API key                             |
| Health        | `GET /api/health`                   | `health()`                  | `health()`                  | none (the key is never sent)               |
| Quota/usage   | `GET /api/v1/me/status`             | `quota()`                   | `quota()`                   | client API key with the `self:usage` scope |
| Route preview | `POST /api/omniroute/route/preview` | `routing.preview()`         | `route_preview()`           | management credential                      |

Sources for each route: `src/app/api/v1/chat/completions/route.ts`, `src/app/api/v1/models/route.ts`, `src/app/api/health/route.ts`, `src/app/api/v1/me/status/route.ts` and `src/app/api/omniroute/route/preview/route.ts`.

- **Quota** uses the self-service status route because it is the usage/quota endpoint a client API key can call for itself. It returns the key's cost window, token totals and, when the key has the `self:account-quota` scope, account quotas. Keys without `self:usage` receive `403`.
- **Route preview** is a management route. Configure `managementKey` (TypeScript) or `management_key` (Python) with a credential accepted by management auth, such as an API key with the `manage` scope; the SDK falls back to the client API key when none is set. The endpoint only ranks the candidates you send and never calls a provider (`liveRequestExecuted` is always `false`). Unknown response fields pass through, so additive server changes do not break the SDK.

## Authentication

Credentials are sent as `Authorization: Bearer` headers. Debug hooks (`onRequest` / `on_request`) receive a header snapshot with every credential header replaced by `[REDACTED]`: `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, `x-goog-api-key`, `x-omniroute-cli-token`, and any other header whose name contains `auth`, `key`, `token`, `secret`, `cookie`, `session` or `password`. The TypeScript client stores keys in private class fields and the Python client redacts them from `repr()`.

Redirects never carry credentials to another origin. The Python client follows redirects like `urllib`, but it drops every credential header when the scheme, host or port changes, and it refuses an `https` to `http` redirect with an `OmniRouteError` that carries the redirect status. The TypeScript client relies on `fetch`, which removes `Authorization` on a cross-origin redirect.

## Request IDs

Every call sends an `x-request-id` header. The same ID is reused across retries of one call. You can pass your own per call (`requestId` / `request_id`) or supply a factory; the default is a random UUID.

The authorization pipeline in `src/server/authz/pipeline.ts` generates its own request ID for each incoming request and returns it in the `x-request-id` response header. It does not reuse the client's value. Each result therefore carries both IDs:

- `requestId` / `request_id`: the server's `x-request-id` response header, falling back to the body `requestId` of management error envelopes, then to the client ID.
- `clientRequestId` / `client_request_id`: the ID the SDK sent.

## Errors

Every failure raises a single `OmniRouteError` with `status`, `code`, `type`, `reason`, `message`, `requestId` / `request_id`, `retryAfterMs` / `retry_after_ms` and the decoded `body`. The parser understands each envelope the server emits:

- `{"error": {"message", "type", "code", "reason"}}` from `open-sse/utils/error.ts`
- `{"error": {"message", "type", "details"}, "requestId"}` from `src/lib/api/errorResponse.ts`
- `{"error": "text"}`, used by some routes such as the self-service status route

Failures without an HTTP response use `status` 0 and a client code: `network_error`, `timeout` or `aborted`. The SDK also raises `invalid_response` for a body that is not a JSON object, `stream_error` for a stream cut mid-way, and `stream_consumed` when a stream is iterated twice. An `error` event inside an SSE stream is raised with the HTTP status of the stream (normally 200).

## Retries and timeouts

- Retries apply to network errors, timeouts and the `retryOn` / `retry_on` statuses (default `408, 429, 500, 502, 503, 504`). Defaults: 2 retries, 500 ms base delay, 8000 ms maximum delay.
- Backoff is exponential (`baseDelayMs * 2^attempt`). A `Retry-After` header, in delta-seconds or HTTP-date form, replaces the computed delay. Either delay is capped by `maxDelayMs`. The final error exposes `retryAfterMs`.
- Pass `retry: false` (TypeScript) or `retry=False` (Python) to disable retries, per client or per call.
- Retries happen only before a successful response is returned. Once a stream has started, nothing is retried: a mid-stream failure raises immediately.
- The timeout (`timeoutMs` / `timeout_ms`, default 60000) applies to each attempt. For streams in TypeScript it covers the time until response headers arrive. In Python it is the socket timeout of each read.

## Streaming

The stream methods send `stream: true` with `Accept: text/event-stream`. They yield each JSON chunk, skip comment lines such as `: keep-alive`, and stop at `data: [DONE]`. In TypeScript, iterate the returned `ChatCompletionStream` with `for await` and call `abort()` or fire the call's `AbortSignal` to stop. In Python, iterate the stream and call `close()`, or use it as a context manager.

## Contract tests

`sdk/contract/fixtures/*.json` hold shared cases. Each case lists the SDK operation and its input, the exact HTTP requests expected (method, path, headers, absent headers, JSON body), the queued server responses, the expected backoff delays, and the expected result, chunks or error.

| Test                                         | What it checks                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/sdk-typescript-contract.test.ts` | TypeScript SDK against every fixture, through an in-process fake `fetch`                                                                                  |
| `tests/unit/sdk-typescript-client.test.ts`   | TypeScript behaviour fixtures cannot express: network retries, timeouts, aborts, mid-stream failures, redaction, SSE framing                              |
| `tests/unit/sdk-openapi-drift.test.ts`       | Every TypeScript operation, every Python operation and every fixture request is an operation in `docs/openapi.yaml`, and both SDKs declare the same table |
| `sdk/python/tests/test_contract.py`          | Python SDK against the same fixtures, through a local `http.server` fake on 127.0.0.1                                                                     |
| `sdk/python/tests/test_client.py`            | Python timeouts, network retries, redaction, stream close, SSE framing                                                                                    |

No test calls an AI provider or any external host.

### Running the tests

TypeScript, from the repository root:

```bash
node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=1 tests/unit/sdk-*.test.ts
npx tsc --noEmit -p sdk/typescript/tsconfig.json
```

The TypeScript tests match the `tests/unit/*.test.ts` glob, so the regular unit runner picks them up.

Python, from `sdk/python`:

```bash
python -m unittest discover -s tests -t . -v
```

The Python tests are not wired into the Node unit runner or CI.

## Not covered

- Other `/api/v1` endpoints (embeddings, images, audio, responses, messages) and every other management route.
- Publishing, versioning and a build step. Both packages are marked private and `sdk/python` carries the `Private :: Do Not Upload` classifier.
- `GET /api/v1/quotas/check`, which answers whether a new registered key can be issued. It is not a usage quota for the calling key.
