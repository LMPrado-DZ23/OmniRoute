---
title: "Your First 10 Minutes with OmniRoute"
version: 3.8.53
lastUpdated: 2026-09-14
---

# Your First 10 Minutes with OmniRoute

🌐 **Languages:** 🇺🇸 English · 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/getting-started/FIRST_10_MINUTES.md)

> **Goal:** go from nothing to a first routed request you can see in the logs. Each step says how to confirm it worked before moving on. For the shortest path see [QUICK-START.md](QUICK-START.md); for every install option see [SETUP_GUIDE.md](../guides/SETUP_GUIDE.md).

> ⚠️ `npm install -g omniroute` installs the **upstream** project (`diegosouzapw/OmniRoute`), not this fork (`LMPrado-DZ23/OmniRoute`). This guide uses the Docker image or the source code. See [QUICK-START.md](QUICK-START.md#step-1-install-omniroute) for the desktop app status.

---

## Minute 0–3: Install

Pick **one**.

### Docker

```bash
docker run -d --name omniroute \
  -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data \
  ghcr.io/lmprado-dz23/omniroute:next
```

- The image sets `PORT=20128` and `DATA_DIR=/app/data` (see `Dockerfile`), so everything you configure lands in the `omniroute-data` volume.
- `:next` is a mutable channel. Pin a version tag or digest for anything you want to reproduce later ([image tags](../guides/DOCKER_GUIDE.md#release-channels)).

### From source

Requires git and a supported Node.js runtime (see [COMPATIBILITY_MATRIX.md](../reference/COMPATIBILITY_MATRIX.md)).

```bash
git clone https://github.com/LMPrado-DZ23/OmniRoute.git
cd OmniRoute
npm ci
npm run check:node-runtime   # fails fast on an unsupported/insecure Node.js version
npm run build
npm start
```

A source install does not put `omniroute` on your `PATH`: wherever this guide shows `omniroute <command>`, run `node bin/omniroute.mjs <command>` from the repository folder.

**Confirm:** `curl -s http://localhost:20128/healthz` answers (the route lives in `src/app/healthz/route.ts`). The default port `20128` comes from `src/lib/runtime/ports.ts`.

---

## Minute 3–4: Open the dashboard and set a password

Open `http://localhost:20128`. What you see depends on `INITIAL_PASSWORD`:

| `INITIAL_PASSWORD` | What happens on first open                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not set            | The onboarding wizard (`/dashboard/onboarding`) asks you to set a dashboard password (or explicitly continue without one for local-only use).                                                                  |
| set                | **The onboarding wizard is skipped.** On first settings read OmniRoute stores `setupComplete=true` and `requireLogin=true` (`src/lib/db/settings.ts`), so you land on `/login` and sign in with that password. |

The bootstrap runs once. After signing in you can still run the guided setup at `/dashboard/onboarding?rerun=1`: it keeps the password you already have and walks through adding a provider, validating the credential, choosing a model, a test request, the client configuration and the first request in the logs. `PATCH /api/settings` with `{"setupComplete": false}` also brings the wizard back, and the setting is no longer re-forced on the next read.

If the password is the `.env.example` placeholder `CHANGEME`, change it right away in **Settings → Security** (`/dashboard/settings/security`). Forgot it? Run `omniroute-reset-password` (from source: `node bin/reset-password.mjs`).

**Confirm:** you see the dashboard home while logged in.

---

## Minute 4–6: Add a provider and validate the credential

1. Go to **Providers** (`/dashboard/providers`) and add a provider. Free, no-card options are listed in [FREE-TIERS-GUIDE.md](FREE-TIERS-GUIDE.md); API-key and OAuth providers are covered in [PROVIDERS-GUIDE.md](PROVIDERS-GUIDE.md).
2. Open the provider and run the connection **test**. The dashboard sends `POST /api/providers/{id}/test` for that connection, which tests the stored credential.
3. From a terminal, against the running server: `omniroute test <provider> <model>` (see `omniroute test --help`).

**Confirm:** the test succeeds. If it fails, fix the credential before continuing; see [TROUBLESHOOTING.md](../guides/TROUBLESHOOTING.md), and [RESILIENCE_GUIDE.md](../architecture/RESILIENCE_GUIDE.md) for cooldowns and circuit breakers.

---

## Minute 6–7: Create an OmniRoute API key

Go to **API Keys** (`/dashboard/api-manager`) and create a key. The dialog says _"Copy and store this key now — it won't be shown again."_ Copy it at that moment; if you lose it, create a new key and delete the old one.

This key authenticates **your tools to OmniRoute**. It is not a provider key. Per [ENVIRONMENT.md](../reference/ENVIRONMENT.md), `REQUIRE_API_KEY` defaults to `false`; set it to `true` on anything reachable by other machines so every `/v1/*` call must carry a valid key.

In the examples below replace `sk-your-omniroute-key` with your key. Never paste real keys into issues, chats or screenshots.

---

## Minute 7–8: Pick a model that is actually available

```bash
curl -s http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-your-omniroute-key"
```

The `data[].id` values are the model IDs you can request. Choose one that belongs to the provider you just validated (or a combo; see [AUTO-COMBO-GUIDE.md](AUTO-COMBO-GUIDE.md)).

---

## Minute 8–9: Send your first request

### curl (OpenAI Chat Completions format)

```bash
curl -s http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-your-omniroute-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-id-from-the-previous-step>",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

`/v1/*` is rewritten to `/api/v1/*` (`next.config.mjs`), so `http://localhost:20128/v1` is the base URL for OpenAI-compatible clients.

### Any OpenAI-compatible SDK (Python example)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:20128/v1",
    api_key="sk-your-omniroute-key",
)
reply = client.chat.completions.create(
    model="<model-id-from-the-previous-step>",
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
)
print(reply.choices[0].message.content)
```

Clients that speak the Anthropic Messages format use `POST /v1/messages`; clients that speak the OpenAI Responses format use `POST /v1/responses`. The full list is in [COMPATIBILITY_MATRIX.md](../reference/COMPATIBILITY_MATRIX.md#client-protocols-and-endpoints).

**Confirm:** you get a completion back instead of an error object.

---

## Minute 9: Copy the client configuration

- **Endpoints** (`/dashboard/endpoint`) shows the base URL your clients should use, with copy buttons.
- For CLI agents, the launchers configure the tool for you, for example `omniroute launch-codex --model <model-id>` or `omniroute run claude`. Per-tool setup: [CLI-INTEGRATIONS.md](../guides/CLI-INTEGRATIONS.md) and [CLI-TOOLS.md](../reference/CLI-TOOLS.md).

Minimum settings for any OpenAI-compatible tool:

```text
Base URL: http://localhost:20128/v1
API key:  sk-your-omniroute-key
Model:    <model-id-from-/v1/models>
```

---

## Minute 10: See the request in the logs

- Dashboard: **Logs** (`/dashboard/logs`) lists recent requests; open one for its details.
- CLI: `omniroute logs --lines 20` (add `--follow` to stream).

**Confirm:** your request from minute 8–9 is in the list. You are done.

---

## Known caveats

- Setting `INITIAL_PASSWORD` skips the onboarding wizard on first boot (see the table above). Use it for headless deploys; to get the guided setup anyway, sign in and open `/dashboard/onboarding?rerun=1`.
- Data location: `DATA_DIR` when set; otherwise an existing `~/.omniroute` is kept, then `%APPDATA%\omniroute` on Windows, `$XDG_CONFIG_HOME/omniroute` when `XDG_CONFIG_HOME` is set, else `~/.omniroute` (`src/lib/dataPaths.ts`). Back it up before upgrading: [BACKUP_RESTORE.md](../ops/BACKUP_RESTORE.md).
- `:next` Docker images change under you. Upgrades, pinning and rollback: [MIGRATION_GUIDE.md](../guides/MIGRATION_GUIDE.md).
- Binding to `127.0.0.1` (as in the Docker example) keeps the gateway local. Before exposing it, read [SECURITY.md](../../SECURITY.md) and [VM_DEPLOYMENT_GUIDE.md](../ops/VM_DEPLOYMENT_GUIDE.md).

## Next steps

- [PROVIDERS-GUIDE.md](PROVIDERS-GUIDE.md): more providers
- [OMNIROUTE_PROVIDER_FAILOVER.md](../OMNIROUTE_PROVIDER_FAILOVER.md): failover behaviour
- [USAGE_QUOTA_GUIDE.md](../guides/USAGE_QUOTA_GUIDE.md): quotas and spend
- [API_REFERENCE.md](../reference/API_REFERENCE.md) and [openapi.yaml](../openapi.yaml): full API
