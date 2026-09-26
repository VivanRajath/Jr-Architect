package core

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed layers/*.dockerfile
var layerFS embed.FS

const CompositePrefix = "sandbox-multi-"

// A repo needing more than one toolchain gets one image carrying all of them, so
// its services share a container and can still reach each other on localhost.
func ImageForStacks(stacks []string) string {
	switch len(stacks) {
	case 0:
		return ""
	case 1:
		return "sandbox-" + stacks[0]
	}
	return CompositeImage(stacks)
}

// Sorted, so the same combination always resolves to the same image and the second
// repo that needs it builds nothing.
func CompositeImage(stacks []string) string {
	return CompositePrefix + strings.Join(normalizeStacks(stacks), "-")
}

func IsComposite(image string) bool {
	return strings.HasPrefix(image, CompositePrefix)
}

// Stacks a composite image name was built from.
func StacksFromImage(image string) []string {
	if !IsComposite(image) {
		return []string{ImageToStack(image)}
	}
	return strings.Split(strings.TrimPrefix(image, CompositePrefix), "-")
}

func normalizeStacks(stacks []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(stacks))
	for _, s := range stacks {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// Toolchain is the language runtime a stack needs, so callers can tell a nested
// subproject of the same project from a genuinely separate service.
func Toolchain(stack string) string { return toolchain(stack) }

// react and node are the same toolchain; so are django and python.
func toolchain(stack string) string {
	switch stack {
	case "react", "builder":
		return "node"
	case "django":
		return "python"
	case "static":
		return "" // served by whatever base is already there
	}
	return stack
}

// Most awkward to bolt onto something else comes first, so it becomes the base and
// only the easier toolchains are layered on with apt.
var basePriority = []struct{ Toolchain, Image string }{
	{"dotnet", "mcr.microsoft.com/dotnet/sdk:8.0"},
	{"java", "docker.io/library/eclipse-temurin:21-jdk-jammy"},
	{"go", "docker.io/library/golang:1.22-bookworm"},
	{"rust", "docker.io/library/rust:1.77-slim-bookworm"},
	{"ruby", "docker.io/library/ruby:3.3-slim"},
	{"php", "docker.io/library/php:8.3-cli"},
	{"bun", "docker.io/oven/bun:debian"},
	{"deno", "docker.io/denoland/deno:debian"},
	{"python", "docker.io/library/python:3.11-slim-bookworm"},
	{"node", "docker.io/library/node:20-bookworm-slim"},
}

// Base image plus the toolchains that still have to be layered onto it.
func composePlan(stacks []string) (string, []string) {
	want := map[string]bool{}
	for _, s := range normalizeStacks(stacks) {
		if tc := toolchain(s); tc != "" {
			want[tc] = true
		}
	}

	base, baseTC := "docker.io/library/debian:bookworm-slim", ""
	for _, b := range basePriority {
		if want[b.Toolchain] {
			base, baseTC = b.Image, b.Toolchain
			break
		}
	}

	var extras []string
	for _, b := range basePriority {
		if want[b.Toolchain] && b.Toolchain != baseTC {
			extras = append(extras, b.Toolchain)
		}
	}
	return base, extras
}

func layer(name string) string {
	b, err := layerFS.ReadFile("layers/" + name + ".dockerfile")
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(b), "\n")
}

func CompositeDockerfile(stacks []string) string {
	base, extras := composePlan(stacks)

	var b strings.Builder
	fmt.Fprintf(&b, "FROM %s\n\n", base)
	b.WriteString("WORKDIR /workspace\n")
	b.WriteString("ENV DEBIAN_FRONTEND=noninteractive\n\n")
	b.WriteString("RUN apt-get update && apt-get install -y --no-install-recommends \\\n")
	b.WriteString("    git curl ca-certificates build-essential pkg-config procps \\\n")
	b.WriteString("    && rm -rf /var/lib/apt/lists/*\n")

	for _, tc := range extras {
		if frag := layer(tc); frag != "" {
			fmt.Fprintf(&b, "\n# %s toolchain\n%s\n", tc, frag)
		}
	}

	// Layered on last: it needs whichever python the steps above provided.
	for _, s := range normalizeStacks(stacks) {
		if s == "django" {
			if frag := layer("django.packages"); frag != "" {
				b.WriteString("\n# django runtime\n" + frag + "\n")
			}
		}
	}

	b.WriteString("\nCMD [\"bash\"]\n")
	return b.String()
}

// Builds the merged image if this combination has never been built. The context is
// a scratch directory: the Dockerfile only installs toolchains, it copies nothing.
func EnsureComposite(container string, stacks []string) (string, error) {
	image := CompositeImage(stacks)
	if ImageExists(image) {
		return image, nil
	}

	dir, err := os.MkdirTemp("", "jr-compose-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(CompositeDockerfile(stacks)), 0644); err != nil {
		return "", err
	}

	AddLog(container, fmt.Sprintf("Building %s for stacks %s — first repo with this combination, later ones reuse it.",
		image, strings.Join(normalizeStacks(stacks), " + ")))
	if err := Run(container, CLI(), "build", "-t", image, dir); err != nil {
		return "", fmt.Errorf("could not build %s: %w", image, err)
	}
	AddLog(container, "Image "+image+" is ready")
	return image, nil
}
