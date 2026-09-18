# omniroute-sdk (TypeScript, experimental)

Minimal, unpublished TypeScript client for OmniRoute. It has zero runtime dependencies, uses the global `fetch` (Node.js 22+), and is ESM consumed from source. See `docs/reference/SDKS.md` for endpoints, error handling, retries and request IDs.

```ts
import { OmniRouteClient, OmniRouteError } from "./src/index.ts";

const client = new OmniRouteClient({
  baseUrl: "http://localhost:20128",
  apiKey: process.env.MY_OMNIROUTE_KEY,
  timeoutMs: 30_000,
  retry: { maxRetries: 2, baseDelayMs: 500 },
});

const MODEL = "<provider>/<model>"; // a model id from client.models.list(); see the note below

const completion = await client.chat.completions.create({
  model: MODEL,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(completion.data.choices[0]?.message.content, completion.requestId);

const stream = await client.chat.completions.stream({
  model: MODEL,
  messages: [{ role: "user", content: "Count to 3" }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? "");

try {
  await client.quota();
} catch (error) {
  if (error instanceof OmniRouteError) console.error(error.status, error.code, error.requestId);
}
```

Replace `<provider>/<model>` with a model id you configured, as listed by `GET /v1/models` (`models.list()`). Avoid `auto` until you have configured providers: `auto` routes to any enabled provider, including built-in keyless third-party free tiers (currently the OpenCode free tier, `oc/*`, allow-listed in `open-sse/services/autoCombo/virtualFactory.ts`). On a fresh install with no provider configured, an `auto` prompt is therefore sent to an external service you never set up. To keep it out of `auto`, add the provider to `blockedProviders` in the dashboard settings or disable its card on the Providers page.

Surface: `chat.completions.create`, `chat.completions.stream`, `models.list`, `health`, `quota`, `routing.preview`, `OmniRouteError`.

Checks, from the repository root:

```bash
npx tsc --noEmit -p sdk/typescript/tsconfig.json
node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=1 tests/unit/sdk-*.test.ts
```
