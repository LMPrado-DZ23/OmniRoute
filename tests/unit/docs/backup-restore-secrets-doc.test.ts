/**
 * Audit C M2 — the backup runbook must say where the auto-generated encryption key lives
 * (`<data-dir>/server.env`) and that `omniroute backup create` does not copy it. This test
 * binds the docs (EN + pt-BR) to the code facts they describe, so either drifting fails.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("BACKUP_RESTORE docs — server.env and the encryption key", () => {
  it("code facts: bootstrap persists secrets to server.env; CLI backup does not copy it", () => {
    const bootstrap = read("scripts/build/bootstrap-env.mjs");
    assert.match(bootstrap, /join\(dataDir, "server\.env"\)/);
    assert.match(bootstrap, /persisted\.STORAGE_ENCRYPTION_KEY = randomBytes/);

    const backup = read("bin/cli/commands/backup.mjs");
    const list = backup.match(/const FILES_TO_BACKUP = \[([\s\S]*?)\];/);
    assert.ok(list, "FILES_TO_BACKUP not found");
    assert.doesNotMatch(list[1], /server\.env|\.env"/);
  });

  for (const doc of ["docs/ops/BACKUP_RESTORE.md", "docs/i18n/pt-BR/docs/ops/BACKUP_RESTORE.md"]) {
    it(`${doc} lists server.env as a secret and says CLI backups skip it`, () => {
      const text = read(doc);
      assert.match(text, /\| `server\.env`\s+\|/, "server.env row in the 'inside' table");
      assert.match(text, /backup create.*(does \*\*not\*\* copy|\*\*não\*\* copia)/);
      assert.match(text, /install -m 600 "<data-dir>\/server\.env"/);
      assert.doesNotMatch(text, /which is not stored in it|que não fica nele/);
    });
  }
});
