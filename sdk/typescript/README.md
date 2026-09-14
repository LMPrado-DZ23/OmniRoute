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

const completion = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(completion.data.choices[0]?.message.content, completion.requestId);

const stream = await client.chat.completions.stream({
  model: "auto",
  messages: [{ role: "user", content: "Count to 3" }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? "");

try {
  await client.quota();
} catch (error) {
  if (error instanceof OmniRouteError) console.error(error.status, error.code, error.requestId);
}
```

Surface: `chat.completions.create`, `chat.completions.stream`, `models.list`, `health`, `quota`, `routing.preview`, `OmniRouteError`.

Checks, from the repository root:

```bash
npx tsc --noEmit -p sdk/typescript/tsconfig.json
node --import tsx/esm --test tests/unit/sdk-*.test.ts
```
