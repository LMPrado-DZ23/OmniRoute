/**
 * Database module: Webhooks
 * CRUD operations for webhook event subscriptions
 */

import { getDbInstance } from "./core";
import { decrypt, encrypt, isEncryptionEnabled } from "./encryption";
import { encryptWebhookSecretsAtRest } from "./encryptionAtRest";
import crypto from "crypto";

export type WebhookKind = "slack" | "telegram" | "discord" | "custom";

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: WebhookKind;
  metadata_encrypted: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  enabled: number;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: string;
  metadata_encrypted: string | null;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    ...row,
    kind: (row.kind as WebhookKind) || "custom",
    events: JSON.parse(row.events || '["*"]'),
    enabled: row.enabled === 1,
    // #8: the HMAC signing secret is encrypted at rest. Decrypt on read so every internal
    // consumer (dispatcher/test HMAC) keeps seeing the plaintext, while the DB/backup only ever
    // holds ciphertext. A stale/absent key yields null here — the delivery then goes unsigned
    // rather than signed with a wrong key.
    secret: row.secret == null ? null : (decrypt(row.secret) ?? null),
  };
}

interface CountResult {
  cnt: number;
}

export function getWebhooks(options?: { limit?: number; offset?: number }): {
  webhooks: Webhook[];
  total: number;
} {
  const db = getDbInstance();
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  let sql = "SELECT * FROM webhooks ORDER BY created_at DESC";
  const params: unknown[] = [];
  if (limit !== undefined) {
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);
  }
  const rows = db.prepare(sql).all(...params) as WebhookRow[];
  const total = (db.prepare("SELECT count(*) as cnt FROM webhooks").get() as CountResult).cnt;
  return { webhooks: rows.map(rowToWebhook), total };
}

export function getWebhook(id: string): Webhook | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : null;
}

export function getEnabledWebhooks(): Webhook[] {
  const db = getDbInstance();
  const rows = db.prepare("SELECT * FROM webhooks WHERE enabled = 1").all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function createWebhook(data: {
  url: string;
  events?: string[];
  secret?: string;
  description?: string;
  kind?: WebhookKind;
  metadataEncrypted?: string | null;
  /** Defaults to true (the historical behaviour). */
  enabled?: boolean;
}): Webhook {
  const db = getDbInstance();
  const id = crypto.randomUUID();
  const secret = data.secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const kind = data.kind || "custom";
  // #8: encrypt the HMAC secret before it touches the DB (passthrough only when no key is
  // configured — hardened to fail-closed in exposed profiles by finding #3).
  const storedSecret = encrypt(secret) ?? secret;

  db.prepare(
    `INSERT INTO webhooks (id, url, events, secret, description, kind, metadata_encrypted, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.url,
    JSON.stringify(data.events || ["*"]),
    storedSecret,
    data.description || "",
    kind,
    data.metadataEncrypted ?? null,
    data.enabled === false ? 0 : 1
  );

  return getWebhook(id)!;
}

export function updateWebhook(
  id: string,
  data: Partial<{
    url: string;
    events: string[];
    secret: string;
    enabled: boolean;
    description: string;
    kind: WebhookKind;
    metadataEncrypted: string | null;
  }>
): Webhook | null {
  const db = getDbInstance();
  const existing = getWebhook(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (data.url !== undefined) {
    fields.push("url = ?");
    values.push(data.url);
  }
  if (data.events !== undefined) {
    fields.push("events = ?");
    values.push(JSON.stringify(data.events));
  }
  if (data.secret !== undefined) {
    fields.push("secret = ?");
    values.push(encrypt(data.secret) ?? data.secret); // #8: encrypt at rest
  }
  if (data.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(data.enabled ? 1 : 0);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.kind !== undefined) {
    fields.push("kind = ?");
    values.push(data.kind);
  }
  if (data.metadataEncrypted !== undefined) {
    fields.push("metadata_encrypted = ?");
    values.push(data.metadataEncrypted);
  }

  if (fields.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  return getWebhook(id);
}

export function deleteWebhook(id: string): boolean {
  const db = getDbInstance();
  const result = db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  return (result as any).changes > 0;
}

export function recordWebhookDelivery(id: string, status: number, success: boolean): void {
  const db = getDbInstance();
  if (success) {
    db.prepare(
      `UPDATE webhooks SET last_triggered_at = datetime('now'), last_status = ?, failure_count = 0 WHERE id = ?`
    ).run(status, id);
  } else {
    db.prepare(
      `UPDATE webhooks SET last_triggered_at = datetime('now'), last_status = ?, failure_count = failure_count + 1 WHERE id = ?`
    ).run(status, id);
  }
}

export function disableWebhooksWithHighFailures(threshold = 10): number {
  const db = getDbInstance();
  const result = db
    .prepare(`UPDATE webhooks SET enabled = 0 WHERE failure_count >= ? AND enabled = 1`)
    .run(threshold);
  return (result as any).changes;
}

/**
 * #8 backfill: encrypt any webhook signing secret still stored in plaintext (pre-migration rows).
 * Idempotent (skips values already carrying the `enc:v1:` prefix) and transactional. No-op when no
 * encryption key is configured (nothing to gain from passthrough re-writes). Returns the count
 * migrated. Runs at DB init alongside the legacy-encryption migration; the signature stays valid
 * because the plaintext round-trips (decrypt-on-read) to the exact same value.
 */
export function encryptExistingWebhookSecrets(): number {
  if (!isEncryptionEnabled()) return 0;
  return encryptWebhookSecretsAtRest(getDbInstance());
}
