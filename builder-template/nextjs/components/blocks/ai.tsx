"use client";

import * as React from "react";
import { AlertCircle, Copy, Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

// The standard home for one AI feature: what it does, a run button, a loading state, the result or an error with retry.
export function AIPanel({ title, description, actionLabel = "Generate", onRun, running, error, children, copyText, className, inputs }: { title: React.ReactNode; description?: React.ReactNode; actionLabel?: string; onRun: () => void; running?: boolean; error?: string | null; children?: React.ReactNode; copyText?: string; className?: string; inputs?: React.ReactNode }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card shadow-sm", className)}>
      <div className="flex items-start gap-3 border-b bg-gradient-to-r from-primary/10 to-transparent px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="font-heading font-semibold tracking-tight">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {copyText && !running && (
          <Button variant="ghost" size="icon" aria-label="Copy" onClick={() => { navigator.clipboard?.writeText(copyText); toast("Copied"); }}><Copy /></Button>
        )}
      </div>
      <div className="space-y-4 p-5">
        {inputs}
        <Button onClick={onRun} disabled={running} className="w-full sm:w-auto">
          {running ? <Loader2 className="animate-spin" /> : <Sparkles />}{running ? "Working…" : actionLabel}
        </Button>
        {running && <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>}
        {error && !running && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{error}</span>
            <button onClick={onRun} className="inline-flex items-center gap-1 font-medium hover:underline"><RotateCcw className="h-3.5 w-3.5" />Retry</button>
          </div>
        )}
        {!running && children}
      </div>
    </section>
  );
}

export type ChatMessage = { role: "user" | "assistant"; content: React.ReactNode };

// A conversation with the app's AI: messages, a typing indicator and an input.
export function ChatPanel({ messages, onSend, busy, placeholder = "Ask anything…", empty, suggestions, className }: { messages: ChatMessage[]; onSend: (text: string) => void; busy?: boolean; placeholder?: string; empty?: React.ReactNode; suggestions?: string[]; className?: string }) {
  const [text, setText] = React.useState("");
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, busy]);
  const send = (t: string) => { const v = t.trim(); if (!v || busy) return; onSend(v); setText(""); };
  return (
    <div className={cn("flex h-[560px] max-h-[75vh] flex-col overflow-hidden rounded-xl border bg-card shadow-sm", className)}>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="grid h-full place-items-center text-center">
            <div className="space-y-3">
              {empty ?? <p className="text-sm text-muted-foreground">Start the conversation.</p>}
              {suggestions && <div className="flex flex-wrap justify-center gap-2">{suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border px-3 py-1 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground">{s}</button>)}</div>}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm", m.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted")}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="flex"><div className="flex gap-1 rounded-2xl rounded-bl-md bg-muted px-4 py-3">{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 120}ms` }} />)}</div></div>}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex items-center gap-2 border-t p-3">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="h-10 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="Send"><Send /></Button>
      </form>
    </div>
  );
}
