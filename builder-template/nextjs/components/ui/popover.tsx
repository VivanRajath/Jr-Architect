"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "./dropdown-menu";

// Same API as shadcn's Popover, sharing the dropdown's open and close behaviour.
const Popover = DropdownMenu;
const PopoverTrigger = DropdownMenuTrigger;

function PopoverContent({ className, align = "center", ...props }: React.HTMLAttributes<HTMLDivElement> & { align?: "start" | "center" | "end"; sideOffset?: number }) {
  return <DropdownMenuContent role="dialog" align={align} className={cn("w-72 p-4", className)} {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent };
