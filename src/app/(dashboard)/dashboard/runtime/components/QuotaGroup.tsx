"use client";

import { useTranslations } from "next-intl";
import { resolveProviderName, type useProviderNodeMap } from "@/lib/display/useProviderNodeMap";

export type QuotaMonitor = {
  sessionId?: string;
  accountId?: string;
  provider?: string;
  window?: string;
  status?: "ok" | "alerting" | "exhausted" | "error" | string;
  remainingPercent?: number;
};

export default function QuotaGroup({
  tone,
  label,
  items,
  nodeMap,
}: {
  tone: "red" | "amber" | "orange";
  label: string;
  items: QuotaMonitor[];
  nodeMap: ReturnType<typeof useProviderNodeMap>;
}) {
  const t = useTranslations("runtime");
  const toneMap = {
    red: { text: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.20)" },
    amber: { text: "#eab308", bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.20)" },
    orange: { text: "#f97316", bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.20)" },
  } as const;
  const tc = toneMap[tone];
  return (
    <div>
      <div
        className="text-[10px] font-bold uppercase tracking-wider mb-1.5"
        style={{ color: tc.text }}
      >
        {label}
      </div>
      <div className="flex flex-col gap-1">
        {items.slice(0, 6).map((m, i) => (
          <div
            key={`${m.accountId ?? ""}:${m.window ?? ""}:${i}`}
            className="rounded-md border px-2.5 py-1.5 flex items-center justify-between gap-2"
            style={{ background: tc.bg, borderColor: tc.border }}
          >
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-text-main truncate">
                {m.accountId ?? "—"}
                {m.provider ? ` / ${resolveProviderName(m.provider, nodeMap)}` : ""}
              </div>
              <div className="text-[10px] text-text-muted">{m.window ?? ""}</div>
            </div>
            {typeof m.remainingPercent === "number" && (
              <span className="text-[11px] font-bold tabular-nums" style={{ color: tc.text }}>
                {Math.round(m.remainingPercent)}%
              </span>
            )}
          </div>
        ))}
        {items.length > 6 && (
          <div className="text-[10px] text-text-muted text-center pt-1">
            {t("moreSuffix", { count: items.length - 6 })}
          </div>
        )}
      </div>
    </div>
  );
}
