"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Toast = { id: number; title: string; description?: string; variant?: "default" | "success" | "destructive" };

let listeners: ((t: Toast[]) => void)[] = [];
let toasts: Toast[] = [];
let nextId = 1;

function emit() {
  listeners.forEach((l) => l(toasts));
}

// Call from anywhere: toast("Saved") or toast("Failed", { description: e.message, variant: "destructive" }).
function toast(title: string, opts: Omit<Toast, "id" | "title"> = {}) {
  const t = { id: nextId++, title, ...opts };
  toasts = [...toasts, t].slice(-3);
  emit();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit(); }, 3500);
}

// Rendered once in app/layout.tsx.
function Toaster() {
  const [items, setItems] = React.useState<Toast[]>([]);
  React.useEffect(() => {
    listeners.push(setItems);
    // Errors thrown in click handlers never reach an error boundary; show their message instead of failing silently.
    const onError = (e: ErrorEvent) => toast("Something went wrong", { description: String(e.message || "Unknown error").slice(0, 200), variant: "destructive" });
    const onRejection = (e: PromiseRejectionEvent) => toast("Something went wrong", { description: String((e.reason && e.reason.message) || e.reason || "Unknown error").slice(0, 200), variant: "destructive" });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      listeners = listeners.filter((l) => l !== setItems);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-0 right-0 z-[100] flex w-full flex-col gap-2 p-4 sm:max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "pointer-events-auto animate-fade-in rounded-lg border bg-background p-4 shadow-lg",
            t.variant === "destructive" && "border-destructive/50 text-destructive",
            t.variant === "success" && "border-success/40"
          )}
        >
          <div className="text-sm font-semibold">{t.title}</div>
          {t.description && <div className="mt-1 text-sm text-muted-foreground">{t.description}</div>}
        </div>
      ))}
    </div>
  );
}

export { toast, Toaster };
