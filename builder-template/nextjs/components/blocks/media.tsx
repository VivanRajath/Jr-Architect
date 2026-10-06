import * as React from "react";
import { cn } from "@/lib/utils";

const COVERS = [
  "from-primary/90 to-primary/50",
  "from-primary/70 via-primary/40 to-accent",
  "from-accent via-primary/30 to-primary/80",
  "from-primary/60 to-muted",
  "from-muted via-accent to-primary/60",
  "from-primary to-primary/70",
];

function pick(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COVERS[h % COVERS.length];
}

// Artwork drawn from the theme: a gradient that varies by seed with a large icon, since the app ships no image files.
export function CoverArt({ icon: Icon, seed = "", className, children, ratio = "aspect-[4/3]" }: { icon?: React.ElementType; seed?: string; className?: string; children?: React.ReactNode; ratio?: string }) {
  return (
    <div className={cn("relative grid place-items-center overflow-hidden bg-gradient-to-br text-primary-foreground", pick(seed), ratio, className)}>
      <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10" />
      <div className="absolute -bottom-10 -left-6 h-28 w-28 rounded-full bg-black/5" />
      {Icon && <Icon className="relative h-1/3 w-1/3 opacity-90" strokeWidth={1.5} />}
      {children}
    </div>
  );
}

// A card for one item in a gallery: cover art, title, meta line, badges and actions.
export function MediaCard({ title, subtitle, icon, seed, meta, badges, actions, onClick, className, coverChildren }: { title: React.ReactNode; subtitle?: React.ReactNode; icon?: React.ElementType; seed?: string; meta?: { icon?: React.ElementType; label: React.ReactNode }[]; badges?: React.ReactNode[]; actions?: React.ReactNode; onClick?: () => void; className?: string; coverChildren?: React.ReactNode }) {
  return (
    <article onClick={onClick} className={cn("group overflow-hidden rounded-xl border bg-card shadow-sm transition-all", onClick && "cursor-pointer hover:-translate-y-0.5 hover:shadow-md", className)}>
      <CoverArt icon={icon} seed={seed ?? String(title)} className="transition-transform duration-300 group-hover:scale-[1.02]">{coverChildren}</CoverArt>
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-heading truncate font-semibold tracking-tight">{title}</h3>
            {subtitle && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0" onClick={(e) => e.stopPropagation()}>{actions}</div>}
        </div>
        {meta && meta.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {meta.map((m, i) => {
              const I = m.icon;
              return <span key={i} className="inline-flex items-center gap-1">{I && <I className="h-3.5 w-3.5" />}{m.label}</span>;
            })}
          </div>
        )}
        {badges && badges.length > 0 && <div className="flex flex-wrap gap-1.5">{badges}</div>}
      </div>
    </article>
  );
}

// A responsive grid for cards.
export function CardGrid({ children, className, size = "md" }: { children: React.ReactNode; className?: string; size?: "sm" | "md" | "lg" }) {
  const cols = { sm: "sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", md: "sm:grid-cols-2 lg:grid-cols-3", lg: "md:grid-cols-2" }[size];
  return <div className={cn("grid gap-4 md:gap-5", cols, className)}>{children}</div>;
}
