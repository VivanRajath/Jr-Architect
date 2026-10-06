"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const AccordionContext = React.createContext<{ open: string[]; toggle: (v: string) => void } | null>(null);
const ItemContext = React.createContext("");

function useAccordion() {
  const ctx = React.useContext(AccordionContext);
  if (!ctx) throw new Error("Accordion parts must be inside <Accordion>");
  return ctx;
}

// Same API as shadcn's Accordion: type single (optionally collapsible) or multiple, with defaultValue.
function Accordion({ type = "single", collapsible = true, defaultValue, className, children }: { type?: "single" | "multiple"; collapsible?: boolean; defaultValue?: string | string[]; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState<string[]>(Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : []);
  const toggle = (v: string) => setOpen((cur) => {
    if (cur.includes(v)) return type === "single" && !collapsible ? cur : cur.filter((x) => x !== v);
    return type === "single" ? [v] : [...cur, v];
  });
  return (
    <AccordionContext.Provider value={{ open, toggle }}>
      <div className={className}>{children}</div>
    </AccordionContext.Provider>
  );
}

function AccordionItem({ value, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  return (
    <ItemContext.Provider value={value}>
      <div className={cn("border-b", className)} {...props} />
    </ItemContext.Provider>
  );
}

function AccordionTrigger({ className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle } = useAccordion();
  const value = React.useContext(ItemContext);
  const isOpen = open.includes(value);
  return (
    <button type="button" aria-expanded={isOpen} onClick={() => toggle(value)} className={cn("flex w-full items-center justify-between py-4 text-left text-sm font-medium transition-all hover:underline", className)} {...props}>
      {children}
      <svg className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}

function AccordionContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = useAccordion();
  const value = React.useContext(ItemContext);
  if (!open.includes(value)) return null;
  return <div className={cn("pb-4 pt-0 text-sm", className)} {...props} />;
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
