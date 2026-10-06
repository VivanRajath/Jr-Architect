"use client";

// Placeholder: Build mode replaces this with the app's own navigation from its pages and design direction.
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home } from "lucide-react";
import { AppShell as Shell } from "@/components/blocks";

export function AppShell({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  const pathname = usePathname() || "/";
  return (
    <Shell brand="App" brandIcon={Home} nav={[{ href: "/", label: "Home", icon: Home }]} current={pathname} linkComponent={Link} actions={actions}>
      {children}
    </Shell>
  );
}
