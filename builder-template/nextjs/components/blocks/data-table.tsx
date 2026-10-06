"use client";

import * as React from "react";
import { ArrowUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

export type Column<T> = { key: string; header: string; render?: (row: T) => React.ReactNode; sortable?: boolean; className?: string; hideOnMobile?: boolean };

// A searchable, sortable table with an empty state; rows can open a detail view.
export function DataTable<T extends Record<string, any>>({ columns, rows, searchKeys, searchPlaceholder = "Search", onRowClick, toolbar, empty, rowKey = (r: T) => String(r.id ?? JSON.stringify(r)) }: { columns: Column<T>[]; rows: T[]; searchKeys?: (keyof T)[]; searchPlaceholder?: string; onRowClick?: (row: T) => void; toolbar?: React.ReactNode; empty?: React.ReactNode; rowKey?: (row: T) => string }) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<{ key: string; dir: 1 | -1 } | null>(null);
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = q && searchKeys ? rows.filter((r) => searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q))) : rows;
    if (sort) out = [...out].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * sort.dir);
    return out;
  }, [rows, query, sort, searchKeys]);
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {(searchKeys || toolbar) && (
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center">
          {searchKeys && (
            <div className="relative sm:max-w-xs sm:flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} className="pl-9" />
            </div>
          )}
          {toolbar && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{toolbar}</div>}
        </div>
      )}
      {shown.length === 0 ? (
        <div className="p-6">{empty ?? <EmptyState icon={<Search />} title={query ? "No matches" : "Nothing here yet"} description={query ? "Try a different search." : "Items you add will show up here."} />}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                {columns.map((c) => (
                  <th key={c.key} className={cn("px-4 py-3 font-medium", c.hideOnMobile && "hidden md:table-cell", c.className)}>
                    {c.sortable ? (
                      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 1 ? -1 : 1 }))}>
                        {c.header}<ArrowUpDown className="h-3 w-3" />
                      </button>
                    ) : c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn("border-b last:border-0 transition-colors", onRowClick && "cursor-pointer hover:bg-muted/40")}>
                  {columns.map((c) => <td key={c.key} className={cn("px-4 py-3", c.hideOnMobile && "hidden md:table-cell", c.className)}>{c.render ? c.render(r) : String(r[c.key] ?? "")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
