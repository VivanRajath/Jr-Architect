"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// A single-series trend line in the brand colour; hovering shows the nearest value.
export function Sparkline({ data, className, format = (v: number) => String(v) }: { data: number[]; className?: string; format?: (v: number) => string }) {
  const [hover, setHover] = React.useState<number | null>(null);
  if (data.length < 2) return null;
  const w = 120, h = 36, pad = 3;
  const min = Math.min(...data), max = Math.max(...data);
  const x = (i: number) => pad + (i * (w - pad * 2)) / (data.length - 1);
  const y = (v: number) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const d = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div className={cn("relative", className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-full overflow-visible" preserveAspectRatio="none"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.round(((e.clientX - r.left) / r.width) * (data.length - 1))); }}
        onMouseLeave={() => setHover(null)} role="img" aria-label={`Trend from ${format(data[0])} to ${format(data[data.length - 1])}`}>
        <path d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null && <circle cx={x(hover)} cy={y(data[hover])} r={3} fill="hsl(var(--primary))" stroke="hsl(var(--card))" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover !== null && <div className="pointer-events-none absolute -top-7 right-0 rounded-md border bg-popover px-2 py-0.5 text-xs shadow-sm">{format(data[hover])}</div>}
    </div>
  );
}

// Vertical bars for one measure across categories; values are on hover and in the accessible table.
export function BarChart({ data, height = 180, format = (v: number) => String(v), className }: { data: { label: string; value: number }[]; height?: number; format?: (v: number) => string; className?: string }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={cn("w-full", className)}>
      <div className="relative flex items-end gap-[2px] border-b border-border" style={{ height }}>
        {data.map((d, i) => (
          <div key={d.label} className="group relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className={cn("w-full max-w-[28px] rounded-t-[4px] bg-primary transition-opacity", hover !== null && hover !== i && "opacity-50")} style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value ? 2 : 0 }} />
            {hover === i && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs shadow-sm">
                <span className="text-muted-foreground">{d.label}</span> <span className="font-medium text-foreground">{format(d.value)}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-[2px]">
        {data.map((d) => <div key={d.label} className="flex-1 truncate text-center text-[11px] text-muted-foreground">{d.label}</div>)}
      </div>
      <table className="sr-only"><tbody>{data.map((d) => <tr key={d.label}><th>{d.label}</th><td>{format(d.value)}</td></tr>)}</tbody></table>
    </div>
  );
}

// A circular meter for one percentage, with the number in the middle.
export function ProgressRing({ value, size = 96, stroke = 8, label, className }: { value: number; size?: number; stroke?: number; label?: React.ReactNode; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <div className={cn("relative inline-grid place-items-center", className)} style={{ width: size, height: size }} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--primary))" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} className="transition-[stroke-dashoffset] duration-500" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div><div className="font-heading text-xl font-semibold tabular-nums">{Math.round(pct)}%</div>{label && <div className="text-[11px] text-muted-foreground">{label}</div>}</div>
      </div>
    </div>
  );
}
