"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type BoardItem = { id: string; title: React.ReactNode; subtitle?: React.ReactNode; badge?: React.ReactNode };
export type BoardColumn = { id: string; title: string; items: BoardItem[] };

// Columns of cards that can be dragged between columns (status boards, pipelines, meal plans).
export function Board({ columns, onMove, onOpen, renderItem, className }: { columns: BoardColumn[]; onMove?: (itemId: string, toColumn: string) => void; onOpen?: (item: BoardItem) => void; renderItem?: (item: BoardItem) => React.ReactNode; className?: string }) {
  const [over, setOver] = React.useState<string | null>(null);
  return (
    <div className={cn("flex gap-4 overflow-x-auto pb-2", className)}>
      {columns.map((col) => (
        <div key={col.id}
          onDragOver={(e) => { if (onMove) { e.preventDefault(); setOver(col.id); } }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => { const id = e.dataTransfer.getData("text/plain"); setOver(null); if (id) onMove?.(id, col.id); }}
          className={cn("flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40 p-3 transition-colors", over === col.id && "border-primary bg-accent/60")}>
          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-sm font-semibold">{col.title}</span>
            <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">{col.items.length}</span>
          </div>
          <div className="flex min-h-16 flex-col gap-2">
            {col.items.map((it) => (
              <div key={it.id} draggable={!!onMove} onDragStart={(e) => e.dataTransfer.setData("text/plain", it.id)} onClick={() => onOpen?.(it)}
                className={cn("rounded-lg border bg-card p-3 text-sm shadow-sm", onMove && "cursor-grab active:cursor-grabbing", onOpen && "hover:border-primary/50")}>
                {renderItem ? renderItem(it) : (
                  <>
                    <div className="font-medium">{it.title}</div>
                    {it.subtitle && <div className="mt-1 text-xs text-muted-foreground">{it.subtitle}</div>}
                    {it.badge && <div className="mt-2">{it.badge}</div>}
                  </>
                )}
              </div>
            ))}
            {col.items.length === 0 && <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">Drop items here</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
