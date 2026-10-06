"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Same API as shadcn's Checkbox: checked + onCheckedChange.
function Checkbox({ checked = false, onCheckedChange, className, disabled, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked?: boolean | "indeterminate"; onCheckedChange?: (v: boolean) => void }) {
  const on = checked === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === "indeterminate" ? "mixed" : on}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!on)}
      className={cn(
        "peer grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        on && "bg-primary text-primary-foreground",
        className
      )}
      {...props}
    >
      {on && (
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      )}
    </button>
  );
}

export { Checkbox };
