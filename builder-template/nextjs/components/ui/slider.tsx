"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Same API as shadcn's Slider (values as an array), on a native range input.
function Slider({ value, defaultValue = [0], min = 0, max = 100, step = 1, onValueChange, className, disabled }: { value?: number[]; defaultValue?: number[]; min?: number; max?: number; step?: number; onValueChange?: (v: number[]) => void; className?: string; disabled?: boolean }) {
  const [inner, setInner] = React.useState(defaultValue);
  const current = (value ?? inner)[0] ?? min;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={current}
      disabled={disabled}
      onChange={(e) => {
        const next = [Number(e.target.value)];
        if (value === undefined) setInner(next);
        onValueChange?.(next);
      }}
      className={cn("h-2 w-full cursor-pointer accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-50", className)}
    />
  );
}

export { Slider };
