"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const MenuContext = React.createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);

function useMenu() {
  const ctx = React.useContext(MenuContext);
  if (!ctx) throw new Error("DropdownMenu parts must be inside <DropdownMenu>");
  return ctx;
}

// Same API as shadcn's DropdownMenu and Popover: a trigger and a floating panel that closes on an outside click.
function DropdownMenu({ children, open, onOpenChange }: { children: React.ReactNode; open?: boolean; onOpenChange?: (v: boolean) => void }) {
  const [inner, setInner] = React.useState(false);
  const current = open ?? inner;
  const ref = React.useRef<HTMLDivElement>(null);
  const setOpen = React.useCallback((v: boolean) => {
    if (open === undefined) setInner(v);
    onOpenChange?.(v);
  }, [open, onOpenChange]);
  React.useEffect(() => {
    if (!current) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); };
  }, [current, setOpen]);
  return (
    <MenuContext.Provider value={{ open: current, setOpen }}>
      <div ref={ref} className="relative inline-block">{children}</div>
    </MenuContext.Provider>
  );
}

function DropdownMenuTrigger({ children }: { children: React.ReactElement<{ onClick?: React.MouseEventHandler }>; asChild?: boolean }) {
  const { open, setOpen } = useMenu();
  return React.cloneElement(children, { onClick: () => setOpen(!open) });
}

function DropdownMenuContent({ className, align = "start", ...props }: React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "center" | "end"; sideOffset?: number }) {
  const { open } = useMenu();
  if (!open) return null;
  const place = { start: "left-0", center: "left-1/2 -translate-x-1/2", end: "right-0" }[align];
  return <div role="menu" className={cn("absolute top-full z-50 mt-2 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md", place, className)} {...props} />;
}

function DropdownMenuItem({ className, onSelect, onClick, ...props }: React.HTMLAttributes<HTMLDivElement> & { onSelect?: () => void; disabled?: boolean }) {
  const { setOpen } = useMenu();
  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={(e) => { onClick?.(e); onSelect?.(); setOpen(false); }}
      onKeyDown={(e) => { if (e.key === "Enter") { onSelect?.(); setOpen(false); } }}
      className={cn("relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent [&>svg]:h-4 [&>svg]:w-4", className)}
      {...props}
    />
  );
}

function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />;
}

function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div className={cn("-mx-1 my-1 h-px bg-muted", className)} />;
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator };
