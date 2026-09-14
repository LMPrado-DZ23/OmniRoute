---
title: "Backup and Restore"
version: 3.8.53
lastUpdated: 2026-09-14
---

# Backup and Restore

🌐 **Languages:** 🇺🇸 English · 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/ops/BACKUP_RESTORE.md)

> **TL;DR:** everything OmniRoute persists lives in one data directory. Back up that directory (consistently, because SQLite runs in WAL mode) **and** your encryption key, which is not stored in it. Schema, SQLite internals and disaster-recovery scenarios are in [DATABASE_GUIDE.md](DATABASE_GUIDE.md#backup-and-recovery); this page is the operator runbook.

---

## 1. What data lives where

### The data directory

The server resolves it in `src/lib/dataPaths.ts` (the CLI mirrors the same logic in `bin/cli/data-dir.mjs`):

1. `DATA_DIR`, when set and non-empty.
2. Otherwise, an existing `~/.omniroute` directory is kept (so upgrades never move your data).
3. Otherwise, on Windows: `%APPDATA%\omniroute`.
4. Otherwise, when `XDG_CONFIG_HOME` is set: `$XDG_CONFIG_HOME/omniroute`.
5. Otherwise: `~/.omniroute`.

If a configured `DATA_DIR` is not writable (`EACCES`/`EPERM`), startup falls back to the default directory instead of crashing (`resolveWritableDataDir` in the same file). Check the startup log if data seems to be "missing" after changing permissions.

Docker images set `DATA_DIR=/app/data` (`Dockerfile`); the repository's `docker-compose.yml` does the same and mounts a volume there.

### What is inside

| Path (relative to the data directory)      | Content                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `storage.sqlite`                           | Main database: providers, connections, keys, combos, settings, usage.                                               |
| `storage.sqlite-wal`, `storage.sqlite-shm` | SQLite write-ahead log and shared memory. Recent writes can live only in the WAL until a checkpoint.                |
| other `*.sqlite` files                     | Sibling databases, when present. `bin/snapshot-data.sh` copies them too.                                            |
| `db_backups/`                              | Server-side backups: automatic/manual copies, pre-migration snapshots and desktop pre-update snapshots (see below). |
| `backups/`                                 | Backups created by the CLI command `omniroute backup create`.                                                       |
| `call_logs/`                               | Request payload artifacts, if enabled ([DATABASE_GUIDE.md](DATABASE_GUIDE.md#database-location)).                   |

### What is **not** inside

- **`STORAGE_ENCRYPTION_KEY`** (legacy alias `OMNIROUTE_CRYPT_KEY`). Sensitive columns are encrypted with it; a restored database is useless for those columns without the same key. Back it up separately, e.g. in a password manager ([DATABASE_GUIDE.md](DATABASE_GUIDE.md#encryption-key)).
- Your deployment configuration (`.env`, compose files, reverse proxy). Keep them in version control or your secret store.

---

## 2. Backup mechanisms

| Mechanism                       | Where it writes                                     | How to trigger                                                                                                         | Notes                                                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server safety copies            | `db_backups/db_*.sqlite`                            | Automatic before writes/imports (`pre-write`, `pre-import`, `pre-json-import`, …) and manual via `PUT /api/db-backups` | Source: `src/lib/db/backup.ts`. Automatic copies are throttled (at most one per 60 minutes), skipped for a database smaller than 4096 bytes, and disabled by `DISABLE_SQLITE_AUTO_BACKUP=true` or the dashboard auto-backup toggle. Manual copies always run. |
| Pre-migration snapshot          | `db_backups/db_state-<sha256>_pre-migration.sqlite` | Automatic, before migrations touch an existing database                                                                | Content-addressed; see [MIGRATION_GUIDE.md](../guides/MIGRATION_GUIDE.md) and `src/lib/db/migrationRunner/preMigrationBackup.ts`.                                                                                                                             |
| Scheduled backups               | Server-side job                                     | `omniroute backup auto enable --cron "0 3 * * *"`; `omniroute backup auto status` / `disable`                          | Schedule semantics and variables: [DATABASE_GUIDE.md](DATABASE_GUIDE.md#automated-backups).                                                                                                                                                                   |
| CLI backup                      | `backups/omniroute-backup-<id>/`                    | `omniroute backup create [--name <name>] [--encrypt --key-file <path>] [--exclude <pattern>] [--retention <n>]`        | Copies `storage.sqlite` plus `settings.json`, `combos.json`, `providers.json` when present, with a `backup-info.json` (`bin/cli/commands/backup.mjs`).                                                                                                        |
| Ops snapshot script             | `db_backups/snapshot_<UTC>[_<label>]/`              | `bin/snapshot-data.sh [--label <name>] [--data-dir <path>]`                                                            | Uses `sqlite3 "VACUUM INTO"` (consistent while running) when `sqlite3` is installed; otherwise copies files, so **stop OmniRoute first**. Prints the snapshot id.                                                                                             |
| Desktop app pre-update snapshot | `db_backups/pre-update-<version>-<timestamp>/`      | Automatic before the desktop app installs an update                                                                    | Copies the database with WAL/SHM, `server.env`, `.env` and `electron-preferences.json`; keeps the newest 3 (`electron/lib/preUpdateSnapshot.js`).                                                                                                             |
| SQLite online backup            | Anywhere you choose                                 | `sqlite3 <data-dir>/storage.sqlite ".backup <target>"`                                                                 | Safe on a live database ([DATABASE_GUIDE.md](DATABASE_GUIDE.md#sqlite-hot-backup)).                                                                                                                                                                           |

### Retention of `db_backups/`

Pruning keeps the newest `DB_BACKUP_MAX_FILES` files (default 20, `MAX_DB_BACKUPS` in `src/lib/db/backupRetention.ts`) with an age limit from `DB_BACKUP_RETENTION_DAYS` (default `0`). Precedence for both: environment variable, then the value saved in the dashboard, then the default. `GET /api/db-backups` lists backups; `PATCH /api/db-backups` saves the retention settings.

The shell scripts in `bin/` honour a `DB_BACKUPS_DIR` environment variable (`bin/_ops-common.sh`); the server itself always uses `<data-dir>/db_backups` (`src/lib/db/core.ts`). If you set `DB_BACKUPS_DIR` for the scripts, the dashboard will not list those snapshots.

### Never copy a live database file by itself

Copying only `storage.sqlite` while OmniRoute runs can miss writes still in `storage.sqlite-wal`. Use one of: `VACUUM INTO` / `.backup`, the snapshot script with `sqlite3` installed, the dashboard/API/CLI backups, or stop OmniRoute and copy the whole data directory.

---

## 3. Restore procedures

Stop clients first: a restore replaces the whole database.

### A. Dashboard or API (server running)

Pick a backup in the dashboard backup list, or call the API with management authentication:

```bash
curl -X POST http://localhost:20128/api/db-backups \
  -H "Authorization: Bearer $MANAGEMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"backupId": "<backup file name from GET /api/db-backups>"}'
```

### B. CLI backups

```bash
omniroute restore --list          # backups under <data-dir>/backups
omniroute restore <backupId>      # add --yes to skip the confirmation
```

### C. Ops scripts (server stopped)

```bash
# 1. stop OmniRoute (service, container or process)
bin/restore-data.sh <snapshot-id> --yes     # --data-dir <path> for a non-default location
# 2. start OmniRoute again
```

`bin/restore-data.sh` first copies the current database to `db_backups/pre-restore_<UTC>/`, deletes the stale `-wal`/`-shm` files, then copies the snapshot's `storage.sqlite` and sibling `*.sqlite` files into place. Without `--yes` it asks for confirmation and refuses to run unattended.

### D. Offline manual copy

The step-by-step copy for a pre-migration snapshot (including removing the WAL sidecars) is in [DATABASE_GUIDE.md](DATABASE_GUIDE.md#rolling-back-a-failed-migration). The same procedure applies to any `.sqlite` backup file.

---

## 4. Verify a restore

Run these in order; stop at the first failure.

1. **File integrity** (server stopped, `sqlite3` installed):

   ```bash
   sqlite3 "<data-dir>/storage.sqlite" "PRAGMA integrity_check;"   # expect: ok
   ```

2. **Startup:** start OmniRoute and read the log. A migration error names a restore point; see [MIGRATION_GUIDE.md](../guides/MIGRATION_GUIDE.md#rollback).
3. **Liveness:** `curl -s http://localhost:20128/healthz`.
4. **Database health** (authenticated): `GET /api/db/health` ([DATABASE_GUIDE.md](DATABASE_GUIDE.md#health-check)).
5. **Data:** log in, check that your providers, API keys and combos are present, and run a provider connection test.
6. **Encryption:** if connections exist but fail with decryption errors, the running `STORAGE_ENCRYPTION_KEY` differs from the one used when the backup was taken.
7. **End to end:** `curl -s http://localhost:20128/v1/models -H "Authorization: Bearer sk-your-omniroute-key"`.

---

## 5. Docker volumes

With the image's `DATA_DIR=/app/data` and a named volume (for example `-v omniroute-data:/app/data`):

**Back up** (stop the container so the copy is consistent):

```bash
docker stop omniroute
docker run --rm -v omniroute-data:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/omniroute-data-backup.tgz -C /data .
docker start omniroute
```

**Restore into a new volume** (keeps the old volume untouched until you are satisfied):

```bash
docker volume create omniroute-data-restored
docker run --rm -v omniroute-data-restored:/data -v "$PWD":/backup alpine \
  tar -xzf /backup/omniroute-data-backup.tgz -C /data
docker stop omniroute && docker rm omniroute
docker run -d --name omniroute -p 127.0.0.1:20128:20128 \
  -v omniroute-data-restored:/app/data ghcr.io/lmprado-dz23/omniroute:<same-tag-as-before>
```

Then run the checks in [section 4](#4-verify-a-restore). Pass the same `STORAGE_ENCRYPTION_KEY` (and other environment) you used before.

With a **bind mount** (e.g. `./data:/app/data`) you can use the ops scripts from the host: `bin/snapshot-data.sh --data-dir ./data` and `bin/restore-data.sh <id> --data-dir ./data --yes`, with the container stopped for the restore.

For the in-app backup list, `docker exec` is not required: use the dashboard or `PUT`/`POST /api/db-backups` against the published port.

---

## Related

- [DATABASE_GUIDE.md](DATABASE_GUIDE.md): schema, migrations, WAL, disaster recovery
- [MIGRATION_GUIDE.md](../guides/MIGRATION_GUIDE.md): upgrades and rollback
- [DOCKER_GUIDE.md](../guides/DOCKER_GUIDE.md): volumes, compose profiles
- [UNINSTALL.md](../guides/UNINSTALL.md): what each uninstall mode keeps or deletes
