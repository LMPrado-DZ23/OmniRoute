---
title: "API Use Cases"
version: 3.8.54
lastUpdated: 2026-09-14
---

# API Use Cases

Ten common flows, each mapped to the operation that serves it in `docs/openapi.yaml` and its stability class. The spec has no `operationId`s (adding them would rename the generated CLI commands), so operations are identified by `METHOD /path`. Stability classes and the compatibility promise behind each one are defined in [API Governance](../architecture/API_GOVERNANCE.md).

`npm run check:api-governance` parses the table below: every row must name a documented operation, and the stability column must match the operation's `x-stability`.

| #   | Use case                                  | Operation                            | Stability      |
| --- | ----------------------------------------- | ------------------------------------ | -------------- |
| 1   | Chat completion (JSON or streaming)       | `POST /api/v1/chat/completions`      | `stable`       |
| 2   | Anthropic Messages (Claude Code)          | `POST /api/v1/messages`              | `stable`       |
| 3   | Count tokens before a Messages call       | `POST /api/v1/messages/count_tokens` | `stable`       |
| 4   | OpenAI Responses API (Codex)              | `POST /api/v1/responses`             | `stable`       |
| 5   | List available models                     | `GET /api/v1/models`                 | `stable`       |
| 6   | Create embeddings                         | `POST /api/v1/embeddings`            | `experimental` |
| 7   | Preview a routing decision without a call | `POST /api/omniroute/route/preview`  | `internal`     |
| 8   | Liveness probe                            | `GET /api/health`                    | `experimental` |
| 9   | Look up provider quota                    | `GET /api/usage/quota`               | `internal`     |
| 10  | Test a provider connection                | `POST /api/providers/{id}/test`      | `internal`     |

All examples use the default local base URL. Client API calls (`/v1/...` is an alias of `/api/v1/...`) authenticate with an OmniRoute API key; management calls need a dashboard session or an API key with the `manage` scope.

## 1. Chat completion

OpenAI-compatible. Set `"stream": true` to receive Server-Sent Events terminated by `data: [DONE]`. Contract test: `tests/e2e/compat-isolated.test.ts`.

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"stream":false}'
```

## 2. Anthropic Messages

The Messages API used by Claude Code. `max_tokens` is required. Contract test: `tests/e2e/compat-isolated.test.ts`.

```bash
curl http://localhost:20128/v1/messages \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude/claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"hi from claude code"}]}'
```

## 3. Count tokens

Returns `input_tokens` for a Messages payload without calling a provider; an empty `messages` array or invalid JSON is rejected with 400. Contract test: `tests/integration/v1-contracts-behavior.test.ts`.

```bash
curl http://localhost:20128/v1/messages/count_tokens \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"abcd"}]}'
```

## 4. Responses API

The OpenAI Responses API used by Codex; `"stream": true` emits `response.output_text.delta` events and ends with `response.completed`. Contract test: `tests/e2e/compat-isolated.test.ts`.

```bash
curl http://localhost:20128/v1/responses \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","input":"hi from codex"}'
```

## 5. List models

Returns `{ "object": "list", "data": [...] }` with every model and combo the key may use. A missing key gets a typed 401 when authentication is required. Contract tests: `tests/integration/v1-contracts-behavior.test.ts`, `tests/e2e/compat-isolated.test.ts`.

```bash
curl http://localhost:20128/v1/models -H "Authorization: Bearer $OMNIROUTE_API_KEY"
```

## 6. Embeddings

OpenAI-compatible embeddings. Experimental: the model-listing `GET` is covered by `tests/integration/v1-contracts-behavior.test.ts`, but the `POST` has no contract test yet.

```bash
curl http://localhost:20128/v1/embeddings \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/text-embedding-3-small","input":"OmniRoute"}'
```

## 7. Routing preview

Deterministically ranks up to 100 candidate provider/model pairs and returns the selection with `liveRequestExecuted: false`. It never calls an upstream provider. Management auth.

```bash
curl http://localhost:20128/api/omniroute/route/preview \
  -H "Authorization: Bearer $OMNIROUTE_MANAGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"candidates":[{"providerId":"openai","modelId":"gpt-4o-mini","capabilityScore":0.9,"allocation":"allow","healthScore":1,"circuit":"closed","quota":"healthy","latencyMs":420}]}'
```

## 8. Liveness probe

Public read-only route for load balancers and container health checks; answers `{ "status": "ok", "timestamp": "..." }` without a key.

```bash
curl http://localhost:20128/api/health
```

## 9. Provider quota

Quota and usage windows for active provider connections. Optional `provider` and `connectionId` query parameters narrow the result. Management auth.

```bash
curl "http://localhost:20128/api/usage/quota?provider=openai" \
  -H "Authorization: Bearer $OMNIROUTE_MANAGE_KEY"
```

## 10. Provider connection test

Probes one stored provider connection. The body is optional; `validationModelId` picks the model used for the probe. Returns 404 when the connection id is unknown. Management auth.

```bash
curl http://localhost:20128/api/providers/<connection-id>/test \
  -H "Authorization: Bearer $OMNIROUTE_MANAGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"validationModelId":"gpt-4o-mini"}'
```
