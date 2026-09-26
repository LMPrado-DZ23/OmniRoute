import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-dupid-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

type IdRow = { id: string; status: number };

test.after(async () => {
  await callLogs.closeCallLogSaves();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// A combo hands every target attempt of one client request the same pending id, and the attempt
// logger uses it as the call_logs primary key. The attempt that answered the client used to hit
// UNIQUE(call_logs.id) and vanish, leaving only the failed attempt in the log.
test("a fallback attempt reusing the request's log id is stored, not dropped", async () => {
  const base = {
    id: "req-shared-1",
    method: "POST",
    path: "/v1/chat/completions",
    model: "gpt-4o-mini",
    provider: "openai",
    comboName: "router-fixed-accounts",
  };
  await callLogs.saveCallLog({ ...base, status: 503, comboStepId: "step-primary", error: "down" });
  await callLogs.saveCallLog({ ...base, status: 200, comboStepId: "step-secondary" });
  await callLogs.saveCallLog({ ...base, status: 200, comboStepId: "step-tertiary" });

  const rows = core
    .getDbInstance()
    .prepare("SELECT id, status FROM call_logs WHERE id LIKE 'req-shared-1%' ORDER BY timestamp, id")
    .all() as IdRow[];

  assert.equal(rows.length, 3, "every attempt must be persisted");
  const byStatus = rows.map((row) => `${row.id}:${row.status}`).sort();
  assert.deepEqual(byStatus, ["req-shared-1:503", "req-shared-1~2:200", "req-shared-1~3:200"]);
});

test("a fresh id is kept verbatim", async () => {
  await callLogs.saveCallLog({
    id: "req-unique-1",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "m",
    provider: "openai",
  });
  const row = core
    .getDbInstance()
    .prepare("SELECT id FROM call_logs WHERE id = 'req-unique-1'")
    .get() as { id: string } | undefined;
  assert.equal(row?.id, "req-unique-1");
});
