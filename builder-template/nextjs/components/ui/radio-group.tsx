"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const RadioContext = React.createContext<{ value: string; setValue: (v: string) => void } | null>(null);

// Same API as shadcn's RadioGroup: value + onValueChange, or defaultValue.
function RadioGroup({ value, defaultValue = "", onValueChange, className, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "defaultValue"> & { value?: string; defaultValue?: string; onValueChange?: (v: string) => void }) {
  const [inner, setInner] = React.useState(defaultValue);
  const current = value ?? inner;
  const setValue = (v: string) => {
    if (value === undefined) setInner(v);
    onValueChange?.(v);
  };
  return (
    <RadioContext.Provider value={{ value: current, setValue }}>
      <div role="radiogroup" className={cn("grid gap-2", className)} {...props} />
    </RadioContext.Provider>
  );
}

function RadioGroupItem({ value, className, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> & { value: string }) {
  const ctx = React.useContext(RadioContext);
  const on = ctx?.value === value;
  return (
    <button type="button" role="radio" aria-checked={on} onClick={() => ctx?.setValue(value)} className={cn("grid aspect-square h-4 w-4 place-items-center rounded-full border border-primary text-primary shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props}>
      {on && <span className="h-2 w-2 rounded-full bg-primary" />}
    </button>
  );
}

export { RadioGroup, RadioGroupItem };
