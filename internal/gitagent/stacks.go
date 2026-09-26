package gitagent

import (
	"fmt"
	"strings"

	"sandbox/internal/core"
)

// stackList puts the primary stack first, then every other stack the repo runs,
// deduped — the order the agent should read its guidance in.
func stackList(primary string, services []core.Service) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(s string) {
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}
	add(primary)
	for _, s := range services {
		add(s.Stack)
	}
	return out
}

func StackList(stacks []string) string {
	if len(stacks) == 0 {
		return "unknown"
	}
	return strings.Join(stacks, " + ")
}

// perStack turns a single-stack guidance function into one that covers a whole
// monorepo, headed per stack so the agent can tell which half a rule belongs to.
func perStack(fn func(string) string) func([]string) string {
	return func(stacks []string) string {
		if len(stacks) == 0 {
			return fn("")
		}
		if len(stacks) == 1 {
			return fn(stacks[0])
		}
		var b strings.Builder
		for i, s := range stacks {
			if i > 0 {
				b.WriteString("\n")
			}
			fmt.Fprintf(&b, "### %s\n%s\n", s, fn(s))
		}
		return strings.TrimRight(b.String(), "\n")
	}
}

// ServicesTable tells the agent which directory belongs to which service, so it
// does not edit the frontend when asked to change the API.
func ServicesTable(services []core.Service) string {
	if len(services) < 2 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n## Services\n\n| Service | Directory | Stack | Framework | Port |\n|---|---|---|---|---|\n")
	for _, s := range services {
		dir := s.Dir
		if dir == "" {
			dir = "."
		}
		port := "-"
		if s.ContainerPort != 0 {
			port = fmt.Sprintf("%d", s.ContainerPort)
		}
		name := s.Name
		if s.Primary {
			name += " (preview)"
		}
		fmt.Fprintf(&b, "| %s | %s/ | %s | %s | %s |\n", name, dir, s.Stack, s.Framework, port)
	}
	b.WriteString("\nEdit only inside the service the request is about; the directories are independent apps.\n")
	return b.String()
}
