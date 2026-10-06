"use client";

import * as React from "react";

// State that starts from the seed data and survives a reload; every page that reads the same key shares the value.
export function useStored<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const storageKey = "app:" + key;
  const [value, setValue] = React.useState<T>(initial);

  // Read after mount so the server render and the first client render match.
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) setValue(JSON.parse(saved));
    } catch {}
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.key === storageKey) setValue(detail.value);
    };
    window.addEventListener("app-stored", onChange);
    return () => window.removeEventListener("app-stored", onChange);
  }, [storageKey]);

  const update = React.useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch {}
      // Other components using the same key update too.
      queueMicrotask(() => window.dispatchEvent(new CustomEvent("app-stored", { detail: { key: storageKey, value: v } })));
      return v;
    });
  }, [storageKey]);

  return [value, update];
}
