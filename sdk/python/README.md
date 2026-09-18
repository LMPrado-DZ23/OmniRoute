# omniroute-sdk (Python, experimental)

Minimal, unpublished Python client for OmniRoute. It uses only the standard library (`urllib`) and needs Python 3.9 or newer. See `docs/reference/SDKS.md` for endpoints, error handling, retries and request IDs.

```python
from omniroute_sdk import OmniRouteClient, OmniRouteError, RetryConfig

client = OmniRouteClient(
    "http://localhost:20128",
    api_key="your-api-key",
    timeout_ms=30_000,
    retry=RetryConfig(max_retries=2, base_delay_ms=500),
)

MODEL = "<provider>/<model>"  # a model id from list_models(); see the note below

completion = client.chat_completions({"model": MODEL, "messages": [{"role": "user", "content": "Hello"}]})
print(completion.data["choices"][0]["message"]["content"], completion.request_id)

with client.stream_chat_completions({"model": MODEL, "messages": [{"role": "user", "content": "Count to 3"}]}) as stream:
    for chunk in stream:
        print(chunk["choices"][0]["delta"].get("content", ""), end="")

try:
    client.quota()
except OmniRouteError as error:
    print(error.status, error.code, error.request_id)
```

Replace `<provider>/<model>` with a model id you configured, as listed by `GET /v1/models` (`list_models()`). Avoid `auto` until you have configured providers: `auto` routes to any enabled provider, including built-in keyless third-party free tiers (currently the OpenCode free tier, `oc/*`, allow-listed in `open-sse/services/autoCombo/virtualFactory.ts`). On a fresh install with no provider configured, an `auto` prompt is therefore sent to an external service you never set up. To keep it out of `auto`, add the provider to `blockedProviders` in the dashboard settings or disable its card on the Providers page.

Surface: `chat_completions`, `stream_chat_completions`, `list_models`, `health`, `quota`, `route_preview`, `OmniRouteError`.

Tests, from this directory. They start a local `http.server` fake on 127.0.0.1 and make no external calls:

```bash
python -m unittest discover -s tests -t . -v
```
