import * as React from "react";
import { cn } from "@/lib/utils";

// A screen's header: optional eyebrow, title, description and actions, then the content.
export function Page({ title, description, eyebrow, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; eyebrow?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-6 md:gap-8", className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          {eyebrow && <div className="text-xs font-medium uppercase tracking-wider text-primary">{eyebrow}</div>}
          <h1 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
          {description && <p className="max-w-2xl text-sm text-muted-foreground md:text-base">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

// A titled group of content; card adds a surface, plain sits on the page.
export function Section({ title, description, actions, children, variant = "card", className, contentClassName }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; variant?: "card" | "plain"; className?: string; contentClassName?: string }) {
  const head = (title || actions) && (
    <div className={cn("flex items-start justify-between gap-4", variant === "card" ? "px-5 pt-5 md:px-6 md:pt-6" : "mb-4")}>
      <div className="min-w-0">
        {title && <h2 className="font-heading text-base font-semibold tracking-tight md:text-lg">{title}</h2>}
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
  if (variant === "plain") {
    return (
      <section className={className}>
        {head}
        <div className={contentClassName}>{children}</div>
      </section>
    );
  }
  return (
    <section className={cn("rounded-xl border bg-card text-card-foreground shadow-sm", className)}>
      {head}
      <div className={cn("p-5 md:p-6", head && "pt-4 md:pt-4", contentClassName)}>{children}</div>
    </section>
  );
}

// A large, tinted banner for a screen's headline moment: a greeting, today's focus, a featured item.
export function Hero({ title, description, actions, aside, eyebrow, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; aside?: React.ReactNode; eyebrow?: React.ReactNode; className?: string }) {
  return (
    <section className={cn("relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/15 via-accent/60 to-background p-6 md:p-10", className)}>
      <div className="relative grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-3">
          {eyebrow && <div className="text-xs font-medium uppercase tracking-wider text-primary">{eyebrow}</div>}
          <h2 className="font-heading text-2xl font-semibold tracking-tight md:text-4xl">{title}</h2>
          {description && <p className="max-w-xl text-muted-foreground">{description}</p>}
          {actions && <div className="flex flex-wrap gap-2 pt-2">{actions}</div>}
        </div>
        {aside && <div className="hidden md:block">{aside}</div>}
      </div>
    </section>
  );
}
