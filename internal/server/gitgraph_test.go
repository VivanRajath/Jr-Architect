package server

import (
	"strings"
	"testing"
)

func TestParseGraphLog(t *testing.T) {
	s := graphSep
	out := strings.Join([]string{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + s + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc" + s + "Octo" + s + "2026-10-06T10:00:00+05:30" + s + "Merge feature" + s + "HEAD -> main, origin/main",
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + s + "" + s + "Octo" + s + "2026-10-05T10:00:00+05:30" + s + "Initial | commit" + s + "",
		"garbage line",
	}, "\n")
	c := parseGraphLog(out)
	if len(c) != 2 {
		t.Fatalf("want 2 commits, got %d", len(c))
	}
	if len(c[0].Parents) != 2 || c[0].Short != "aaaaaaa" || len(c[0].Refs) != 2 || c[0].Refs[0] != "HEAD -> main" {
		t.Fatalf("merge commit parsed wrong: %+v", c[0])
	}
	if len(c[1].Parents) != 0 || c[1].Subject != "Initial | commit" {
		t.Fatalf("root commit parsed wrong: %+v", c[1])
	}
}
