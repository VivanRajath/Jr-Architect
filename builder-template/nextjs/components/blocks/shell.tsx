"use client";

import * as React from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export type NavItem = { href: string; label: string; icon: React.ElementType; badge?: string };

type ShellProps = {
  brand: string;
  brandIcon?: React.ElementType;
  nav: NavItem[];
  current: string;
  variant?: "sidebar" | "topbar" | "bottom";
  // Next.js passes next/link here; anything else renders plain links.
  linkComponent?: React.ElementType;
  // For apps without a router: called instead of following the link.
  onNavigate?: (href: string) => void;
  actions?: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  children: React.ReactNode;
};

function NavLink({ item, active, linkComponent: L = "a", onNavigate, className, onDone, vertical }: { item: NavItem; active: boolean; linkComponent?: React.ElementType; onNavigate?: (href: string) => void; className?: string; onDone?: () => void; vertical?: boolean }) {
  const Icon = item.icon;
  return (
    <L
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={(e: React.MouseEvent) => {
        if (onNavigate) {
          e.preventDefault();
          onNavigate(item.href);
        }
        onDone?.();
      }}
      className={cn(
        "group flex items-center gap-3 rounded-md text-sm font-medium transition-colors",
        vertical ? "flex-col gap-1 px-2 py-1.5 text-[11px]" : "px-3 py-2",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className
      )}
    >
      <Icon className={cn("shrink-0", vertical ? "h-5 w-5" : "h-4 w-4", active && "text-primary")} />
      <span className="truncate">{item.label}</span>
      {item.badge && !vertical && <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{item.badge}</span>}
    </L>
  );
}

function Brand({ name, icon: Icon }: { name: string; icon?: React.ElementType }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {Icon && (
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Icon className="h-4 w-4" />
        </span>
      )}
      <span className="font-heading truncate text-base font-semibold tracking-tight">{name}</span>
    </div>
  );
}

const isActive = (current: string, href: string) => current === href || (href !== "/" && href !== "home" && current.startsWith(href + "/"));

// The whole app frame: a sidebar workspace, a top navigation bar, or a phone-style bottom tab bar.
const InShell = React.createContext(false);

export function AppShell(props: ShellProps) {
  if (React.useContext(InShell)) return <>{props.children}</>;
  return <InShell.Provider value={true}><Frame {...props} /></InShell.Provider>;
}

function Frame({ brand, brandIcon, nav, current, variant = "sidebar", linkComponent, onNavigate, actions, sidebarFooter, children }: ShellProps) {
  const [drawer, setDrawer] = React.useState(false);
  const link = (item: NavItem, extra?: { className?: string; vertical?: boolean; onDone?: () => void }) => (
    <NavLink key={item.href + item.label} item={item} active={isActive(current, item.href)} linkComponent={linkComponent} onNavigate={onNavigate} {...extra} />
  );

  if (variant === "sidebar") {
    return (
      <div className="min-h-screen bg-background text-foreground md:grid md:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-screen flex-col border-r bg-card/60 md:flex">
          <div className="flex h-16 items-center px-5"><Brand name={brand} icon={brandIcon} /></div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">{nav.map((n) => link(n))}</nav>
          <div className="flex items-center justify-between gap-2 border-t px-4 py-3">{sidebarFooter ?? <span className="text-xs text-muted-foreground">Saved on this device</span>}<ThemeToggle /></div>
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-50 bg-black/50 md:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setDrawer(false); }}>
            <div className="flex h-full w-72 flex-col bg-background shadow-xl">
              <div className="flex h-16 items-center justify-between px-5"><Brand name={brand} icon={brandIcon} /><button aria-label="Close menu" onClick={() => setDrawer(false)} className="rounded-md p-2 hover:bg-accent"><X className="h-4 w-4" /></button></div>
              <nav className="flex flex-col gap-1 px-3">{nav.map((n) => link(n, { onDone: () => setDrawer(false) }))}</nav>
            </div>
          </div>
        )}
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur md:px-8">
            <button aria-label="Open menu" onClick={() => setDrawer(true)} className="rounded-md p-2 hover:bg-accent md:hidden"><Menu className="h-5 w-5" /></button>
            <div className="md:hidden"><Brand name={brand} /></div>
            <div className="ml-auto flex items-center gap-2">{actions}<span className="md:hidden"><ThemeToggle /></span></div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("min-h-screen bg-background text-foreground", variant === "bottom" && "pb-20 md:pb-0")}>
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 md:px-8">
          <Brand name={brand} icon={brandIcon} />
          <nav className={cn("min-w-0 items-center gap-1 overflow-x-auto", variant === "bottom" ? "hidden md:flex" : "hidden sm:flex")}>{nav.map((n) => link(n))}</nav>
          <div className="ml-auto flex items-center gap-2">{actions}<ThemeToggle /></div>
        </div>
        {variant === "topbar" && <nav className="flex gap-1 overflow-x-auto px-4 pb-2 sm:hidden">{nav.map((n) => link(n, { className: "shrink-0" }))}</nav>}
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</main>
      {variant === "bottom" && (
        <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-background/95 px-2 py-1.5 backdrop-blur md:hidden">
          {nav.slice(0, 5).map((n) => link(n, { vertical: true, className: "min-w-0 flex-1" }))}
        </nav>
      )}
    </div>
  );
}
