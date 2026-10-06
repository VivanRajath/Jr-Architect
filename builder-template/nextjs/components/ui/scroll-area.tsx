import * as React from "react";
import { cn } from "@/lib/utils";

// Same API as shadcn's ScrollArea, with native scrolling.
function ScrollArea({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("relative overflow-auto", className)} {...props}>
      {children}
    </div>
  );
}

function ScrollBar(_props: { orientation?: "vertical" | "horizontal" }) {
  return null;
}

export { ScrollArea, ScrollBar };
