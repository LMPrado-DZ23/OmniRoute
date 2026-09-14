"use client";

import { cn } from "@/shared/utils/cn";

interface SidebarSectionHeaderProps {
  title: string;
  isExpanded: boolean;
  isPinned: boolean;
  pinLabel: string;
  onToggle: () => void;
  onTogglePin: () => void;
}

/**
 * Collapsible sidebar section header. The expand control and the pin control are
 * sibling <button>s: the previous `div[role=button]` wrapped the pin button (nested
 * interactive controls) and could not be reached or operated from the keyboard.
 * The pin button is positioned over the header so the visual layout is unchanged.
 */
export default function SidebarSectionHeader({
  title,
  isExpanded,
  isPinned,
  pinLabel,
  onToggle,
  onTogglePin,
}: SidebarSectionHeaderProps) {
  return (
    <div className="relative group/header">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex w-full cursor-pointer items-center gap-0.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface/30"
      >
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted transition-colors group-hover/header:text-text-main">
          {title}
        </span>
        <span className="w-3.5 shrink-0" aria-hidden="true" />
        <span
          aria-hidden="true"
          className={cn(
            "material-symbols-outlined shrink-0 text-[14px] text-text-muted/40 transition-all duration-200 group-hover/header:text-text-muted/70",
            isExpanded && "rotate-180"
          )}
        >
          expand_more
        </span>
      </button>

      <button
        type="button"
        onClick={onTogglePin}
        aria-pressed={isPinned}
        aria-label={pinLabel}
        title={pinLabel}
        className={cn(
          "absolute right-6 top-1/2 -translate-y-1/2 rounded p-0.5 transition-all",
          isPinned
            ? "text-primary opacity-100"
            : "text-text-muted/30 opacity-0 hover:text-text-muted/70 focus-visible:opacity-100 group-hover/header:opacity-100"
        )}
      >
        <span
          aria-hidden="true"
          className="material-symbols-outlined"
          style={{
            fontSize: "10px",
            ...(isPinned ? { fontVariationSettings: "'FILL' 1" } : {}),
          }}
        >
          push_pin
        </span>
      </button>
    </div>
  );
}
