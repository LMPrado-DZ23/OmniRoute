---
title: "OmniRoute — Uninstall Guide"
version: 3.8.51
lastUpdated: 2026-09-11
---

# OmniRoute — Uninstall Guide

🌐 **Languages:** 🇺🇸 [English](./UNINSTALL.md) | 🇸🇦 [العربية](../i18n/ar/docs/guides/UNINSTALL.md) | 🇦🇿 [Azərbaycan dili](../i18n/az/docs/guides/UNINSTALL.md) | 🇧🇬 [Български](../i18n/bg/docs/guides/UNINSTALL.md) | 🇧🇩 [বাংলা](../i18n/bn/docs/guides/UNINSTALL.md) | 🇨🇿 [Čeština](../i18n/cs/docs/guides/UNINSTALL.md) | 🇩🇰 [Dansk](../i18n/da/docs/guides/UNINSTALL.md) | 🇩🇪 [Deutsch](../i18n/de/docs/guides/UNINSTALL.md) | 🇪🇸 [Español](../i18n/es/docs/guides/UNINSTALL.md) | 🇮🇷 [فارسی](../i18n/fa/docs/guides/UNINSTALL.md) | 🇫🇮 [Suomi](../i18n/fi/docs/guides/UNINSTALL.md) | 🇫🇷 [Français](../i18n/fr/docs/guides/UNINSTALL.md) | 🇮🇳 [ગુજરાતી](../i18n/gu/docs/guides/UNINSTALL.md) | 🇮🇱 [עברית](../i18n/he/docs/guides/UNINSTALL.md) | 🇮🇳 [हिन्दी](../i18n/hi/docs/guides/UNINSTALL.md) | 🇭🇺 [Magyar](../i18n/hu/docs/guides/UNINSTALL.md) | 🇮🇩 [Bahasa Indonesia](../i18n/id/docs/guides/UNINSTALL.md) | 🇮🇹 [Italiano](../i18n/it/docs/guides/UNINSTALL.md) | 🇯🇵 [日本語](../i18n/ja/docs/guides/UNINSTALL.md) | 🇰🇷 [한국어](../i18n/ko/docs/guides/UNINSTALL.md) | 🇮🇳 [मराठी](../i18n/mr/docs/guides/UNINSTALL.md) | 🇲🇾 [Bahasa Melayu](../i18n/ms/docs/guides/UNINSTALL.md) | 🇳🇱 [Nederlands](../i18n/nl/docs/guides/UNINSTALL.md) | 🇳🇴 [Norsk](../i18n/no/docs/guides/UNINSTALL.md) | 🇵🇭 [Filipino](../i18n/phi/docs/guides/UNINSTALL.md) | 🇵🇱 [Polski](../i18n/pl/docs/guides/UNINSTALL.md) | 🇵🇹 [Português (Portugal)](../i18n/pt/docs/guides/UNINSTALL.md) | 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/guides/UNINSTALL.md) | 🇷🇴 [Română](../i18n/ro/docs/guides/UNINSTALL.md) | 🇷🇺 [Русский](../i18n/ru/docs/guides/UNINSTALL.md) | 🇸🇰 [Slovenčina](../i18n/sk/docs/guides/UNINSTALL.md) | 🇸🇪 [Svenska](../i18n/sv/docs/guides/UNINSTALL.md) | 🇰🇪 [Kiswahili](../i18n/sw/docs/guides/UNINSTALL.md) | 🇮🇳 [தமிழ்](../i18n/ta/docs/guides/UNINSTALL.md) | 🇮🇳 [తెలుగు](../i18n/te/docs/guides/UNINSTALL.md) | 🇹🇭 [ไทย](../i18n/th/docs/guides/UNINSTALL.md) | 🇹🇷 [Türkçe](../i18n/tr/docs/guides/UNINSTALL.md) | 🇺🇦 [Українська](../i18n/uk-UA/docs/guides/UNINSTALL.md) | 🇵🇰 [اردو](../i18n/ur/docs/guides/UNINSTALL.md) | 🇻🇳 [Tiếng Việt](../i18n/vi/docs/guides/UNINSTALL.md) | 🇨🇳 [中文 (简体)](../i18n/zh-CN/docs/guides/UNINSTALL.md) | 🇹🇼 [中文 (繁體)](../i18n/zh-TW/docs/guides/UNINSTALL.md)

This guide removes OmniRoute from your computer. Go to the section that matches **how you installed it**. No step deletes your data unless it says so explicitly — read the warning before running those commands.

---

## Before you start: where your data lives

OmniRoute keeps everything (database, providers, API keys, settings) in one data directory. Uninstalling the app never touches it unless you run the "erase" commands below.

| How you run OmniRoute            | Default data directory                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Windows (desktop app, source)    | `%APPDATA%\omniroute` — if a `%USERPROFILE%\.omniroute` folder from an older install already exists, that one is used |
| macOS / Linux (desktop, source)  | `~/.omniroute` — or `$XDG_CONFIG_HOME/omniroute` when `XDG_CONFIG_HOME` is set                                        |
| Docker                           | `/app/data` inside the container, i.e. the `omniroute-data` volume from the documented `docker run`                   |
| Any of the above with `DATA_DIR` | The directory in the `DATA_DIR` environment variable, exactly as you set it                                           |

Files you will find there:

| File / directory                    | What it is                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `storage.sqlite` (+ `-wal`, `-shm`) | Main database — providers, combos, settings, API keys                                  |
| `db_backups/`                       | Automatic database backups (including the `pre-update-*` snapshots of the desktop app) |
| `server.env`                        | Desktop app only — the generated secrets (`JWT_SECRET`, encryption keys)               |
| `electron-preferences.json`         | Desktop app only — window and tray preferences                                         |

To keep your setup for a later reinstall, leave this directory alone (or copy it somewhere first).

---

## Desktop app (Windows, macOS, Linux)

1. Quit OmniRoute completely: right-click the tray icon → **Quit** (closing the window only hides it).
2. Remove the app:
   - **Windows:** `Settings → Apps → Installed apps → OmniRoute → Uninstall`.
   - **macOS:** drag `OmniRoute.app` from `/Applications` to the Trash.
   - **Linux:** delete the `.AppImage` file you downloaded.
3. Your data directory (table above) is **kept**. Only if you want to erase everything:

> ⚠️ **Irreversible.** Deleting the data directory erases your providers, API keys, combos and usage history. Take a backup first if in doubt.

```bash
# macOS / Linux
rm -rf ~/.omniroute
```

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:APPDATA\omniroute"
```

---

## Docker

```bash
# Stop and remove the container — your data stays in the volume
docker stop omniroute
docker rm omniroute
```

Only if you also want to erase your data:

> ⚠️ **Irreversible.** `docker volume rm` deletes the database, providers and API keys stored in the volume.

```bash
docker volume rm omniroute-data
```

Optional — free the disk space used by the image:

```bash
docker rmi ghcr.io/lmprado-dz23/omniroute:latest
```

With Docker Compose: `docker compose down` removes the containers and keeps the data; `docker compose down -v` also deletes the volumes (irreversible).

---

## Installed from source (`git clone`)

These two scripts exist **only inside the cloned repository** — run them from the `OmniRoute` folder. They are not available for the desktop app or Docker.

### Keep your data

```bash
npm run uninstall
```

What it does: stops a background `omniroute` process if you started one with PM2, runs `npm uninstall -g omniroute` (a no-op when no global npm package is installed — but note it **would** remove the upstream npm package if you also have that installed), prints where your data directory is and **keeps it**.

### Erase everything

```bash
npm run uninstall:full
```

> ⚠️ **Irreversible.** This erases the data directory: database, providers, API keys, combos, usage history.

Because it is irreversible, the script never erases on the flag alone:

- On a terminal it prints the exact directory that will be erased and asks you to type `ERASE` (anything else keeps your data).
- In scripts or non-interactive shells it refuses and exits with status 1 unless you pass `--yes`:

```bash
npm run uninstall:full -- --yes
```

The script resolves the data directory exactly like the app does (table above): `DATA_DIR` when that variable is set, otherwise `%APPDATA%\omniroute` on Windows (or a legacy `%USERPROFILE%\.omniroute` if one exists), `~/.omniroute` (or `$XDG_CONFIG_HOME/omniroute`) on macOS/Linux — it prints the folder before asking for confirmation. Only if your data lives somewhere else, point it there explicitly:

```powershell
$env:DATA_DIR = "$env:APPDATA\omniroute"; npm run uninstall:full
```

### Then delete the cloned folder

Neither script removes the repository itself. Delete the `OmniRoute` folder you cloned (Explorer / Finder, or `rm -rf /path/to/OmniRoute` — double-check the path first).

---

## Installed the upstream npm package (`npm install -g omniroute`)

That package is the **original project**, not this fork. Remove it with:

```bash
npm uninstall -g omniroute
# or, with pnpm:
pnpm remove -g omniroute
```

Your data directory follows the same table as above and is kept unless you delete it yourself.

---

## Verify it is gone

```bash
# Global npm package (should print nothing)
npm list -g omniroute

# Data directory (only present if you chose to keep it)
ls -la ~/.omniroute

# Running processes (macOS / Linux)
pgrep -f omniroute
```

On Windows, open Task Manager and confirm there is no **OmniRoute** process, and check `%APPDATA%\omniroute` in Explorer.
