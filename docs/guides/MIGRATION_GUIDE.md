---
title: "Upgrade and Migration Guide"
version: 3.8.54
lastUpdated: 2026-09-18
---

# Upgrade and Migration Guide

🌐 **Languages:** 🇺🇸 English · 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/guides/MIGRATION_GUIDE.md)

> **TL;DR:** read the changelog → back up the data directory and the encryption key → upgrade with the same method you installed with → let OmniRoute apply database migrations on startup → verify. To go back: restore the backup taken before the upgrade **and** run the previous version.

---

## 1. Before you upgrade

1. **Note what you run now:** `omniroute --version` (from source: `node bin/omniroute.mjs --version`), or the Docker image tag **and digest**.
2. **Read what changed** between your version and the target: [CHANGELOG.md](../../CHANGELOG.md) (the `## [Unreleased]` section plus one section per released version). Pay attention to removed or renamed environment variables ([ENVIRONMENT.md](../reference/ENVIRONMENT.md)), removed providers ([REMOVED_PROVIDERS.md](../reference/REMOVED_PROVIDERS.md)) and runtime requirements ([COMPATIBILITY_MATRIX.md](../reference/COMPATIBILITY_MATRIX.md)).
3. **Back up** the data directory and keep `STORAGE_ENCRYPTION_KEY` safe: [BACKUP_RESTORE.md](../ops/BACKUP_RESTORE.md). If you never set the key yourself, it lives in `<data-dir>/server.env`, which `omniroute backup create` does not copy ([details](../ops/BACKUP_RESTORE.md#secrets-and-the-encryption-key)). OmniRoute also takes its own pre-migration snapshot (below), but it covers only the main database file.
4. **Plan the rollback target:** keep the previous image tag/digest, git tag or installer available.

---

## 2. What happens on the first start of a new version

Database migrations run **automatically at startup**; there is no separate migrate command.

- `src/lib/db/core.ts` calls `runMigrations` from `src/lib/db/migrationRunner.ts` while opening the database.
- Migration files are the numbered SQL files in `src/lib/db/migrations/` (`OMNIROUTE_MIGRATIONS_DIR` overrides the location; `OMNIROUTE_EXTRA_MIGRATIONS_DIRS` adds extra directories).
- Before touching an **existing** database, the runner writes a content-addressed snapshot `db_backups/db_state-<sha256>_pre-migration.sqlite` (`src/lib/db/migrationRunner/preMigrationBackup.ts`) and refuses to migrate if that snapshot changed before use.
- Each pending migration runs in its own transaction and is recorded in the `_omniroute_migrations` table. A failed migration is rolled back, is not recorded, aborts startup and prints a `Restore point (...)` line naming the snapshot file.
- Safety checks abort startup instead of guessing: renumbered migrations (applied name differs from the file on disk) are reported as critical, and an unusually large number of pending migrations on an existing database (the "tracking table was wiped" case) is refused unless you set `OMNIROUTE_MAX_PENDING_MIGRATIONS=0`.
- Migrations are **forward-only**: there are no down scripts.

More detail: [DATABASE_GUIDE.md](../ops/DATABASE_GUIDE.md#migrations).

---

## 3. Upgrade paths

### Docker

Images: `ghcr.io/lmprado-dz23/omniroute` with the channels and variants listed in [COMPATIBILITY_MATRIX.md](../reference/COMPATIBILITY_MATRIX.md#docker-images-and-architectures). Pin `X.Y.Z` (or a digest) in production; `latest`, `next` and `main` move.

```bash
docker pull ghcr.io/lmprado-dz23/omniroute:X.Y.Z
docker stop omniroute && docker rm omniroute          # removes the container, not the volume
docker run -d --name omniroute -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data \
  ghcr.io/lmprado-dz23/omniroute:X.Y.Z
docker logs -f omniroute                               # watch the migrations and startup
```

Reuse the same volume and the same environment (`STORAGE_ENCRYPTION_KEY`, `INITIAL_PASSWORD`, …).

**Compose:** the repository's `docker-compose.yml` services use `build:` and tag local images (`omniroute:base`, `omniroute:web`, …). Upgrading them means updating the checkout (see "From source" below for choosing a tag) and rebuilding, e.g. `docker compose build` followed by `docker compose up -d` with the profile you use. If your own compose file references the registry image instead, change the tag and run `docker compose pull` then `docker compose up -d`.

### From source

```bash
git fetch --tags
git checkout vX.Y.Z
npm ci
npm run check:node-runtime
npm run build
# restart the process (npm start, your service manager, PM2, …)
```

`npm ci` is required because dependencies change between versions.

### npm global install

The npm package name `omniroute` is shared with the upstream project ([QUICK-START.md](../getting-started/QUICK-START.md#step-1-install-omniroute)). The built-in updater guards against installing another fork: `omniroute update --apply` only trusts the npm "latest" when the registry manifest points at `LMPrado-DZ23/OmniRoute` (`bin/cli/commands/update.mjs`).

```bash
omniroute update --check        # exit 0 if up to date, 1 if outdated
omniroute update --dry-run      # show what would run
omniroute update --apply        # creates a backup first unless --no-backup
```

### Desktop app (Electron)

The app uses `electron-updater` against this repository's GitHub Releases ([ELECTRON_GUIDE.md](ELECTRON_GUIDE.md#auto-update)). It does not download automatically; after you accept, it installs on quit. Before installing, it writes `db_backups/pre-update-<version>-<timestamp>/` with the database, `server.env`, `.env` and preferences, keeping the newest 3 (`electron/lib/preUpdateSnapshot.js`).

---

## 4. Verify the upgrade

1. The startup log shows no migration error and the server stays up.
2. `omniroute --version` (or the dashboard sidebar) reports the target version.
3. `curl -s http://localhost:20128/healthz` answers.
4. `curl -s http://localhost:20128/v1/models -H "Authorization: Bearer sk-your-omniroute-key"` lists your models.
5. A provider connection test succeeds and a test request appears in **Logs** (`/dashboard/logs`).

---

## Rollback

Starting the **newer** version again against a restored database simply re-applies the same migrations, so a rollback always has two parts:

1. **Stop OmniRoute.**
2. **Restore the data from before the upgrade:**
   - the `db_state-<sha256>_pre-migration.sqlite` snapshot named in the error, following [DATABASE_GUIDE.md](../ops/DATABASE_GUIDE.md#rolling-back-a-failed-migration), or
   - your own backup, following [BACKUP_RESTORE.md](../ops/BACKUP_RESTORE.md#3-restore-procedures), or
   - for the desktop app, the files in `db_backups/pre-update-<version>-<timestamp>/`.
3. **Run the previous version:**
   - Docker: start the previous tag or digest with the restored volume.
   - Source: `git checkout v<previous>`, `npm ci`, `npm run build`, restart.
   - Servers deployed with the ops tooling: `bin/rollback.sh [<version>] [--method npm|docker]`. With no version it picks the highest published release below the current `package.json` version. The `docker` method re-tags an image `omniroute:<version>` that must already exist locally and recreates the service from `docker-compose.prod.yml`.

If the restored database came from a state whose migration ledger was wiped, the pending-migration guard can abort startup; the abort message explains `OMNIROUTE_MAX_PENDING_MIGRATIONS`.

---

## Where breaking changes are announced

| Source                                                                | What to look for                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [CHANGELOG.md](../../CHANGELOG.md)                                    | Per-version sections; the `## [Unreleased]` section for the next release. |
| `changelog.d/`                                                        | Fragments for changes not yet folded into the changelog.                  |
| [GitHub Releases](https://github.com/LMPrado-DZ23/OmniRoute/releases) | Release notes and assets for each tag.                                    |
| [ENVIRONMENT.md](../reference/ENVIRONMENT.md)                         | Added, renamed or removed environment variables.                          |
| [REMOVED_PROVIDERS.md](../reference/REMOVED_PROVIDERS.md)             | Providers that no longer exist.                                           |
| [COMPATIBILITY_MATRIX.md](../reference/COMPATIBILITY_MATRIX.md)       | Runtime, OS and image changes.                                            |
| [BRANCHING_MODEL.md](../ops/BRANCHING_MODEL.md)                       | Which branch/tag a version comes from.                                    |

Found a regression after upgrading? Open a **Regression** issue (`.github/ISSUE_TEMPLATE/regression.yml`) with the last good version.
