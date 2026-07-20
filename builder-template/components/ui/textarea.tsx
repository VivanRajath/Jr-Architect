import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border px-3 py-2 text-sm placeholder:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 resize-y transition-shadow",
          className
        )}
        style={{
          background: "var(--surface2)",
          borderColor: "var(--border)",
          color: "var(--text)",
          // @ts-ignore
          "--tw-ring-color": "var(--brand-500)",
        }}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
