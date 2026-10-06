"use client";

import * as React from "react";
import { ArrowLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

// Two panes: a list and the selected item's detail. On phones only one shows, with a back button.
export function ListDetail({ list, detail, showDetail = false, onBack, listWidth = "360px", className }: { list: React.ReactNode; detail: React.ReactNode; showDetail?: boolean; onBack?: () => void; listWidth?: string; className?: string }) {
  return (
    <div className={cn("grid gap-6 md:grid-cols-[var(--list-w)_minmax(0,1fr)]", className)} style={{ ["--list-w" as string]: listWidth }}>
      <div className={cn("min-w-0", showDetail && "hidden md:block")}>{list}</div>
      <div className={cn("min-w-0", !showDetail && "hidden md:block")}>
        {onBack && <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"><ArrowLeft className="h-4 w-4" />Back</button>}
        {detail}
      </div>
    </div>
  );
}

// Main content with a narrower side column (filters, summary, AI panel) that drops below on phones.
export function SplitLayout({ main, side, sideWidth = "340px", sideFirst = false, className }: { main: React.ReactNode; side: React.ReactNode; sideWidth?: string; sideFirst?: boolean; className?: string }) {
  return (
    <div className={cn("grid gap-6 lg:grid-cols-[minmax(0,1fr)_var(--side-w)]", sideFirst && "lg:grid-cols-[var(--side-w)_minmax(0,1fr)]", className)} style={{ ["--side-w" as string]: sideWidth }}>
      {sideFirst ? <><aside className="min-w-0 space-y-6">{side}</aside><div className="min-w-0 space-y-6">{main}</div></> : <><div className="min-w-0 space-y-6">{main}</div><aside className="min-w-0 space-y-6">{side}</aside></>}
    </div>
  );
}

// Search plus filter controls in one row above a list or grid.
export function FilterBar({ query, onQuery, placeholder = "Search", children, actions, className }: { query?: string; onQuery?: (q: string) => void; placeholder?: string; children?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center", className)}>
      {onQuery && (
        <div className="relative sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query ?? ""} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} className="pl-9" />
        </div>
      )}
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      {actions && <div className="flex items-center gap-2 sm:ml-auto">{actions}</div>}
    </div>
  );
}

// Pill toggles for a small set of options (categories, statuses, levels).
export function ChipGroup({ options, value, onChange, multiple = false, className }: { options: string[]; value: string | string[]; onChange: (v: any) => void; multiple?: boolean; className?: string }) {
  const selected = Array.isArray(value) ? value : [value];
  return (
    <div className={cn("flex flex-wrap gap-2", className)} role="group">
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button key={o} type="button" aria-pressed={on}
            onClick={() => onChange(multiple ? (on ? selected.filter((x) => x !== o) : [...selected, o]) : o)}
            className={cn("rounded-full border px-3 py-1 text-sm transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground")}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

// Numbered steps for a wizard or a guided flow.
export function Stepper({ steps, current, className }: { steps: string[]; current: number; className?: string }) {
  return (
    <ol className={cn("flex items-center gap-2 overflow-x-auto", className)}>
      {steps.map((s, i) => (
        <li key={s} className="flex shrink-0 items-center gap-2">
          <span className={cn("grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold", i < current ? "border-primary bg-primary text-primary-foreground" : i === current ? "border-primary text-primary" : "text-muted-foreground")}>{i + 1}</span>
          <span className={cn("text-sm", i === current ? "font-medium text-foreground" : "text-muted-foreground")}>{s}</span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border md:w-10" />}
        </li>
      ))}
    </ol>
  );
}

// A vertical history of events.
export function Timeline({ items, className }: { items: { title: React.ReactNode; description?: React.ReactNode; time?: React.ReactNode; icon?: React.ElementType }[]; className?: string }) {
  return (
    <ol className={cn("relative space-y-5 border-l pl-6", className)}>
      {items.map((it, i) => {
        const I = it.icon;
        return (
          <li key={i} className="relative">
            <span className="absolute -left-[33px] grid h-6 w-6 place-items-center rounded-full border bg-background text-primary">{I ? <I className="h-3.5 w-3.5" /> : <span className="h-2 w-2 rounded-full bg-primary" />}</span>
            <div className="flex flex-wrap items-baseline justify-between gap-2"><div className="font-medium">{it.title}</div>{it.time && <div className="text-xs text-muted-foreground">{it.time}</div>}</div>
            {it.description && <div className="mt-0.5 text-sm text-muted-foreground">{it.description}</div>}
          </li>
        );
      })}
    </ol>
  );
}
