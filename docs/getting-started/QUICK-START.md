---
title: "Quick Start: Get OmniRoute Running in 3 Minutes"
version: 3.8.51
lastUpdated: 2026-09-11
---

# Quick Start: Get OmniRoute Running in 3 Minutes

🌐 **Languages:** 🇺🇸 English · 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/getting-started/QUICK-START.md)

> **TL;DR**: Install → Connect a free provider → Point your IDE to OmniRoute. Done.

> ⚠️ **Before you run anything:** `npm install -g omniroute` installs the **original project** (`diegosouzapw/OmniRoute`, published on npm by the upstream author), **not** this fork (`LMPrado-DZ23/OmniRoute`). This fork ships **only** through the channels below: the desktop installer on GitHub Releases, the Docker image `ghcr.io/lmprado-dz23/omniroute`, and the source code.

---

## Step 1: Install OmniRoute

All three methods below install **this fork**. Pick one:

### Option A: Desktop app (Windows, macOS, Linux)

Download the file for your OS from this fork's [Releases](https://github.com/LMPrado-DZ23/OmniRoute/releases) page — `.exe` on Windows, `.dmg` on macOS, `.AppImage` or `.deb` on Linux, each for x64 and arm64 — and open it. The app starts the embedded server, lives in the system tray and updates itself (always asking before installing; a snapshot of your data is written to `db_backups/pre-update-*` before every update).

### Option B: Docker (works today)

This fork publishes `ghcr.io/lmprado-dz23/omniroute:latest` and `:next-web`, built from the current default branch. Every publish boots the image and requires it to answer `/healthz` before the tag is left in place.

```bash
docker run -d --name omniroute -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data ghcr.io/lmprado-dz23/omniroute:latest
```

Your data lives in the `omniroute-data` volume (`/app/data` inside the container). `:next` is mutable — pulling later can give you a newer build; pin a digest for a reproducible deployment. `:latest` is the highest **published** stable SemVer and starts existing once a version is released. It does **not** track git `main`. Pin `ghcr.io/lmprado-dz23/omniroute:X.Y.Z` for GitOps. See [Image Tags / Release Channels](../guides/DOCKER_GUIDE.md#release-channels).

### Option C: From source (works today)

Requires **Node.js 22 or 24 LTS** and **git**. Copy and paste one line at a time:

```bash
git clone https://github.com/LMPrado-DZ23/OmniRoute.git
cd OmniRoute
npm ci
npm run build
npm start
```

- `npm ci` installs the dependencies exactly as locked in the repository; `npm run build` builds the dashboard; `npm start` starts the server at `http://localhost:20128`.
- For development (hot reload, no `build` step): `npm run dev`.
- A source install does **not** put an `omniroute` command on your PATH. Wherever this guide shows `omniroute <something>`, run `node bin/omniroute.mjs <something>` from inside the `OmniRoute` folder.

---

## Step 2: Start OmniRoute

It depends on the method you chose in Step 1:

- **Desktop app:** open OmniRoute like any other program. It starts the server and opens the dashboard.
- **Docker:** the container is already running after `docker run`. To stop/start it again: `docker stop omniroute` / `docker start omniroute`.
- **From source:** inside the `OmniRoute` folder, `npm start` (or `npm run dev`).

In every case the dashboard is at `http://localhost:20128`.

### What happens on first open

The behaviour depends on whether the `INITIAL_PASSWORD` variable is set (it ships in `.env.example` as `CHANGEME`; it only takes effect if you copied that file to `.env` or passed `-e INITIAL_PASSWORD=...` to Docker):

- **Without `INITIAL_PASSWORD`** (the default for the desktop app and for a source install with no `.env`): the **setup wizard** appears. There you set a **password** for the dashboard or tick **"skip password"** (local access without login). It then offers to connect a free provider.
- **With `INITIAL_PASSWORD` set** (typical for Docker and servers): the wizard does **not** appear. OmniRoute marks setup as complete, requires login and goes straight to the **login page** — sign in with the password from the variable. If it is still the default `CHANGEME`, change it **immediately** in **Settings → Security** (OmniRoute logs a warning that this password is publicly known).

Forgot the password? Run `omniroute-reset-password` (from source: `node bin/reset-password.mjs`).

---

## Step 3: Connect a Free Provider

You can use OmniRoute **without paying anything** by connecting a free provider.

### Option A: Kiro (Free Claude — No Credit Card)

1. Open the dashboard at `http://localhost:20128`
2. Go to **Providers** → **Add Provider**
3. Select **Kiro AI**
4. Click **Connect** (no API key needed!)
5. Done! You now have free access to Claude models.

### Option B: OpenCode Free (No Auth)

1. Open the dashboard at `http://localhost:20128`
2. Go to **Providers** → **Add Provider**
3. Select **OpenCode Free**
4. Click **Connect** (no API key needed!)
5. Done! You now have free access to multiple models.

### Option C: Pollinations (No Key Needed)

1. Open the dashboard at `http://localhost:20128`
2. Go to **Providers** → **Add Provider**
3. Select **Pollinations**
4. Click **Connect** (no API key needed!)
5. Done! You now have free access to GPT-5, Claude, Gemini, and more.

---

## Step 4: Create Your Key and Verify It Works

From [API Keys](http://localhost:20128/dashboard/api-manager), create a new key.

> 🔑 **The key is shown exactly once**, in the dialog that opens right after creation ("it won't be shown again"). **Copy it at that moment** and store it somewhere safe. After that the dashboard only shows it masked. If you lose it there is no way to recover it: create **another** key (and delete the old one).

This key is for your tools to access OmniRoute, not to access upstream providers.

```bash
curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_KEY"
```

You should see your connected models listed.

---

## Step 5: Point Your IDE or CLI to OmniRoute

In your IDE or CLI tool, set:

```
Base URL: http://localhost:20128/v1
API Key:  the key you copied in Step 4 (the dashboard will not show it again)
Model:    auto
```

That's it! Your IDE now uses OmniRoute with automatic provider selection.

> Installed from source? In every `omniroute …` command below, use `node bin/omniroute.mjs …` from inside the `OmniRoute` folder.

### IDE Example: VSCode/Continue.dev

1. In VSCode, install the [Continue.dev](https://marketplace.visualstudio.com/items?itemName=Continue.continue) extension.
2. Update your `~/.continue/config.yaml` to add the following lines:

```
  - name: OmniRoute - Auto
    provider: openai
    model: auto
    apiBase: http://localhost:20128/v1
    apiKey: <YOUR_KEY>
```

3. In the Continue.dev chat pane, select `OmniRoute - Auto` and you will make requests to OmniRoute.
4. (Optional) Exercise for the reader - have your IDE update the `config.yaml` with all the other prebuilt configurations 😊

### CLI Example: Codex CLI

1. In your operating system, set the environment variable persistently.
   For macOS/Linux (add to your `~/.bashrc` or `~/.zshrc`):

```bash
export OMNIROUTE_API_KEY="<YOUR_KEY>"
```

For Windows (Command Prompt):

```
setx OMNIROUTE_API_KEY <YOUR_KEY>
```

2. Now let's launch Codex, but configured for OmniRoute. Run:

```
omniroute launch-codex --model auto
```

You can do this manually via `codex` and command line parameters to specify endpoint and api key, but with the above command, OmniRoute takes care of everything for you.

The same one-command launch works for other CLIs via the generic launcher — `omniroute run <target>` supports `claude`, `codex`, `aider`, `goose`, `opencode`, `qwen`, and `gemini` (see [CLI Integrations](../guides/CLI-INTEGRATIONS.md)).

3. The CLI should be sending requests to OmniRoute now.

### Confirm your tool is routing to OmniRoute

You can see the details of the request by clicking [Monitoring/Logs](http://localhost:20128/dashboard/logs) from the left sidebar. Clicking through shows you more details. As a side note, you can see what info gets sent up from your favorite harness. This is helpful from an educational and debugging perspective.

---

## Close, Reopen, Recover, Uninstall

- **Where your data lives:** Windows `%APPDATA%\omniroute`; macOS and Linux `~/.omniroute`; Docker in the `omniroute-data` volume. Nothing is deleted on uninstall unless you ask for it.
- **Backup and restore:** `omniroute backup create` / `omniroute backup restore` — details in the [Database Guide](../ops/DATABASE_GUIDE.md).
- **Uninstall:** depends on how you installed — desktop app: the operating system's uninstaller; Docker: `docker stop omniroute && docker rm omniroute`; source: `npm run uninstall` (keeps your data) or `npm run uninstall:full` (asks you to type `ERASE` before wiping everything). Step by step, with the warnings, in the [Uninstall Guide](../guides/UNINSTALL.md).

---

## What's Next?

- **[Auto-Combo Guide](./AUTO-COMBO-GUIDE.md)** — Let OmniRoute pick the best AI for you
- **[Providers Guide](./PROVIDERS-GUIDE.md)** — Connect more providers (free and paid)
- **[Free Tiers Guide](./FREE-TIERS-GUIDE.md)** — Get free AI with no credit card
- **[Troubleshooting](../guides/TROUBLESHOOTING.md)** — Fix common issues

---

## Common Questions

### "Do I need an API key?"

**No!** You can use free providers (Kiro, OpenCode Free, Pollinations) without any API key. Just connect them in the dashboard. The key from **Step 4** is the one your tools use to talk to OmniRoute.

### "What is `auto`?"

`auto` tells OmniRoute to automatically pick the best provider for each request. It considers speed, cost, quality, and availability. See the [Auto-Combo Guide](./AUTO-COMBO-GUIDE.md) for details.

### "How much does it cost?"

OmniRoute itself is **free and open-source**. You only pay for the providers you use. Many providers have free tiers — see the [Free Tiers Guide](./FREE-TIERS-GUIDE.md).

### "Can I use it with Claude Code / Cursor / Copilot?"

**Yes!** OmniRoute works with any tool that supports OpenAI format. Just set the base URL to `http://localhost:20128/v1`. See the [CLI Tools Guide](../reference/CLI-TOOLS.md) for specific setup instructions.

### "What if a provider goes down?"

OmniRoute automatically skips failed providers and tries the next one. You don't need to do anything. See the [Auto-Combo Guide](./AUTO-COMBO-GUIDE.md) for details.

---

## Need Help?

- **[Troubleshooting](../guides/TROUBLESHOOTING.md)** — Common issues and fixes
- **[Discord](https://discord.gg/U47eFqAXCn)** — Community support
- **[GitHub Issues](https://github.com/LMPrado-DZ23/OmniRoute/issues)** — Report bugs
