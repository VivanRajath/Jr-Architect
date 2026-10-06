import * as React from "react";
import { cn } from "@/lib/utils";

// Same API as shadcn's Tooltip, shown on hover and focus with CSS only.
function TooltipProvider({ children }: { children: React.ReactNode; delayDuration?: number }) {
  return <>{children}</>;
}

function Tooltip({ children }: { children: React.ReactNode }) {
  return <span className="group/tooltip relative inline-flex">{children}</span>;
}

function TooltipTrigger({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) {
  return asChild ? <>{children}</> : <span tabIndex={0}>{children}</span>;
}

function TooltipContent({ className, side = "top", ...props }: React.HTMLAttributes<HTMLDivElement> & { side?: "top" | "bottom" | "left" | "right"; sideOffset?: number }) {
  const place = { top: "bottom-full left-1/2 mb-2 -translate-x-1/2", bottom: "top-full left-1/2 mt-2 -translate-x-1/2", left: "right-full top-1/2 mr-2 -translate-y-1/2", right: "left-full top-1/2 ml-2 -translate-y-1/2" }[side];
  return <div role="tooltip" className={cn("pointer-events-none absolute z-50 hidden w-max max-w-xs rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow group-hover/tooltip:block group-focus-within/tooltip:block", place, className)} {...props} />;
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent };
