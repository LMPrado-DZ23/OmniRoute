"use client";

/**
 * Settings → Security — Browser Use domain allowlist editor: the draft list (add, remove), the
 * save action and a confirmed clear-all action. The parent keys this component by the saved
 * list, so a successful save re-seeds the draft while a rejected draft stays editable.
 *
 * The client only trims/lowercases/strips leading dots and skips duplicates; the server is the
 * authority on what a valid host is (no scheme, path, port, wildcard or IP literal).
 */
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { ConfirmModal } from "@/shared/components/Modal";

import type { DomainRejectionReason, RejectedDomain } from "./useBrowserAllowlist";

interface AllowlistEditorProps {
  savedDomains: string[];
  maxDomains: number;
  saving: boolean;
  rejected: RejectedDomain[];
  onSave: (domains: string[]) => Promise<boolean>;
}

const REASON_KEYS: Record<DomainRejectionReason, string> = {
  empty: "reasonEmpty",
  too_long: "reasonTooLong",
  invalid_characters: "reasonInvalidCharacters",
  non_ascii: "reasonNonAscii",
  ip_literal: "reasonIpLiteral",
  single_label: "reasonSingleLabel",
  invalid_label: "reasonInvalidLabel",
};

function normalizeDraft(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, "");
}

const BUTTON_PRIMARY =
  "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50";
const BUTTON_SECONDARY =
  "rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-subtle disabled:opacity-50";

export function AllowlistEditor(props: AllowlistEditorProps) {
  const { savedDomains, maxDomains, saving, rejected, onSave } = props;
  const t = useTranslations("browserAllowlist");
  const [draft, setDraft] = useState<string[]>(savedDomains);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const dirty = draft.join("\n") !== savedDomains.join("\n");

  const clearAll = async () => {
    setConfirmingClear(false);
    if (await onSave([])) setDraft([]);
  };

  return (
    <div className="space-y-3">
      <AddDomainForm draft={draft} maxDomains={maxDomains} onAdd={(d) => setDraft([...draft, d])} />
      <DomainList draft={draft} onRemove={(d) => setDraft(draft.filter((x) => x !== d))} />
      <p data-testid="browser-allowlist-count" className="text-xs text-text-muted">
        {t("count", { count: draft.length, max: maxDomains })}
      </p>
      {rejected.length > 0 && <RejectedList rejected={rejected} />}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="browser-allowlist-save"
          onClick={() => void onSave(draft)}
          disabled={saving || !dirty}
          className={BUTTON_PRIMARY}
        >
          {saving ? t("saving") : t("save")}
        </button>
        <button
          type="button"
          data-testid="browser-allowlist-clear"
          onClick={() => setConfirmingClear(true)}
          disabled={saving || (savedDomains.length === 0 && draft.length === 0)}
          className={BUTTON_SECONDARY}
        >
          {t("clearAll")}
        </button>
      </div>
      {confirmingClear && (
        <div data-testid="browser-allowlist-clear-confirm">
          <ConfirmModal
            isOpen
            onClose={() => setConfirmingClear(false)}
            onConfirm={() => void clearAll()}
            title={t("clearConfirmTitle")}
            message={t("clearConfirmMessage", { count: savedDomains.length })}
            confirmText={t("clearAll")}
            variant="danger"
            loading={saving}
          />
        </div>
      )}
    </div>
  );
}

interface AddDomainFormProps {
  draft: string[];
  maxDomains: number;
  onAdd: (domain: string) => void;
}

function AddDomainForm({ draft, maxDomains, onAdd }: AddDomainFormProps) {
  const t = useTranslations("browserAllowlist");
  const [value, setValue] = useState("");
  const candidate = normalizeDraft(value);
  const duplicate = candidate !== "" && draft.includes(candidate);
  const full = draft.length >= maxDomains;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!candidate || duplicate || full) return;
    onAdd(candidate);
    setValue("");
  };

  return (
    <form onSubmit={submit} className="space-y-1">
      <label htmlFor="browser-allowlist-input" className="text-sm font-medium text-text-primary">
        {t("addLabel")}
      </label>
      <p id="browser-allowlist-hint" className="text-xs text-text-muted">
        {t("addHint")}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="browser-allowlist-input"
          type="text"
          data-testid="browser-allowlist-input"
          aria-describedby="browser-allowlist-hint"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("addPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 rounded-lg border border-border bg-bg-subtle px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
        />
        <button
          type="submit"
          data-testid="browser-allowlist-add"
          disabled={!candidate || duplicate || full}
          className={BUTTON_SECONDARY}
        >
          {t("add")}
        </button>
      </div>
      {duplicate && (
        <p
          data-testid="browser-allowlist-duplicate"
          className="text-xs text-amber-700 dark:text-amber-300"
        >
          {t("alreadyListed", { domain: candidate })}
        </p>
      )}
      {full && (
        <p
          data-testid="browser-allowlist-full"
          className="text-xs text-amber-700 dark:text-amber-300"
        >
          {t("limitReached", { max: maxDomains })}
        </p>
      )}
    </form>
  );
}

function DomainList({ draft, onRemove }: { draft: string[]; onRemove: (domain: string) => void }) {
  const t = useTranslations("browserAllowlist");
  if (draft.length === 0) {
    return (
      <p
        data-testid="browser-allowlist-empty"
        className="rounded-lg border border-dashed border-border p-3 text-sm text-text-muted"
      >
        {t("empty")}
      </p>
    );
  }
  return (
    <ul
      aria-label={t("listLabel")}
      data-testid="browser-allowlist-list"
      className="flex flex-wrap gap-2"
    >
      {draft.map((domain) => (
        <li
          key={domain}
          data-testid="browser-allowlist-item"
          className="flex items-center gap-1 rounded-full border border-border bg-bg-subtle py-0.5 pl-3 pr-1 font-mono text-xs text-text-primary"
        >
          <span data-testid="browser-allowlist-item-domain">{domain}</span>
          <button
            type="button"
            onClick={() => onRemove(domain)}
            aria-label={t("remove", { domain })}
            title={t("remove", { domain })}
            className="rounded-full p-0.5 text-text-muted hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/10"
          >
            <span className="material-symbols-outlined text-sm" aria-hidden="true">
              close
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RejectedList({ rejected }: { rejected: RejectedDomain[] }) {
  const t = useTranslations("browserAllowlist");
  return (
    <div
      data-testid="browser-allowlist-rejected"
      className="text-sm text-red-700 dark:text-red-300"
    >
      <p className="font-medium">{t("rejectedTitle")}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {rejected.map((entry) => (
          <li key={`${entry.domain}-${entry.reason}`}>
            <code className="font-mono">{entry.domain}</code> — {t(REASON_KEYS[entry.reason])}
          </li>
        ))}
      </ul>
    </div>
  );
}
