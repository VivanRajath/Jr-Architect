import * as React from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./charts";

export function StatGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>{children}</div>;
}

// One headline number: label, value, optional change and trend.
export function StatCard({ label, value, icon: Icon, delta, deltaLabel, trend, hint, className }: { label: string; value: React.ReactNode; icon?: React.ElementType; delta?: number; deltaLabel?: string; trend?: number[]; hint?: React.ReactNode; className?: string }) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className={cn("rounded-xl border bg-card p-5 shadow-sm", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {Icon && <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="font-heading text-2xl font-semibold tracking-tight tabular-nums md:text-3xl">{value}</div>
          {delta !== undefined && (
            <div className="mt-1 flex items-center gap-1 whitespace-nowrap text-xs">
              <span className={cn("inline-flex items-center gap-0.5 font-medium", up ? "text-success" : "text-destructive")}>
                {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{Math.abs(delta)}%
              </span>
              {deltaLabel && <span className="text-muted-foreground">{deltaLabel}</span>}
            </div>
          )}
          {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
        </div>
        {trend && trend.length > 1 && <Sparkline data={trend} className="w-24" />}
      </div>
    </div>
  );
}
