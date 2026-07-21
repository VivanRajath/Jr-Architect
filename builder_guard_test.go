package main

import (
	"strings"
	"testing"
)

func TestThirdPartyRefs(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    []string // substrings expected in the flagged refs (empty = expect none)
	}{
		{
			name: "clean local app",
			content: `"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { resumes } from "@/lib/data";
export default function Page() { return null }`,
			want: nil,
		},
		{
			name:    "google oauth import",
			content: `import { google } from "googleapis";`,
			want:    []string{"googleapis"},
		},
		{
			name:    "next-auth sign in",
			content: `import { signIn } from "next-auth/react";`,
			want:    []string{"next-auth"},
		},
		{
			name:    "stripe payments",
			content: `import Stripe from "stripe";`,
			want:    []string{"stripe"},
		},
		{
			name:    "external fetch",
			content: "const r = await fetch(`https://api.example.com/x`);",
			want:    []string{"fetch()"},
		},
		{
			name:    "external fetch double quotes",
			content: `fetch("http://mail.google.com/send")`,
			want:    []string{"fetch()"},
		},
		{
			name:    "allowed lucide + next subpaths ok",
			content: `import { Mail } from "lucide-react"; import { useRouter } from "next/navigation";`,
			want:    nil,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := thirdPartyRefs(c.content)
			if len(c.want) == 0 {
				if len(got) != 0 {
					t.Fatalf("expected no refs, got %v", got)
				}
				return
			}
			joined := strings.Join(got, " | ")
			for _, w := range c.want {
				if !strings.Contains(joined, w) {
					t.Fatalf("expected ref containing %q, got %v", w, got)
				}
			}
		})
	}
}
