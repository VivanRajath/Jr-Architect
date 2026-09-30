package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The name is the cache key: the same combination must always resolve to the same image, whatever order detection happened to find the stacks in.
func TestCompositeImageIsOrderIndependent(t *testing.T) {
	a := CompositeImage([]string{"react", "django"})
	b := CompositeImage([]string{"django", "react"})
	if a != b {
		t.Fatalf("%q != %q — the same repo would build twice", a, b)
	}
	if a != "sandbox-multi-django-react" {
		t.Errorf("CompositeImage = %q", a)
	}
	if got := CompositeImage([]string{"node", "node", "python"}); got != "sandbox-multi-node-python" {
		t.Errorf("duplicates not collapsed: %q", got)
	}
}

func TestImageForStacks(t *testing.T) {
	cases := map[string]string{
		"react":         "sandbox-react",
		"django":        "sandbox-django",
		"static":        "sandbox-static",
		"django,react":  "sandbox-multi-django-react",
		"go,node,pyton": "sandbox-multi-go-node-pyton",
	}
	for in, want := range cases {
		if got := ImageForStacks(strings.Split(in, ",")); got != want {
			t.Errorf("ImageForStacks(%q) = %q, want %q", in, got, want)
		}
	}
	if got := ImageForStacks(nil); got != "" {
		t.Errorf("ImageForStacks(nil) = %q, want empty", got)
	}
}

// A composite name has to survive the round trip, because EnsureImage rebuilds the stack list from it.
func TestStacksFromImageRoundTrip(t *testing.T) {
	stacks := []string{"django", "go", "react"}
	got := StacksFromImage(CompositeImage(stacks))
	if strings.Join(got, ",") != strings.Join(stacks, ",") {
		t.Errorf("round trip gave %v, want %v", got, stacks)
	}
	if got := StacksFromImage("sandbox-django"); len(got) != 1 || got[0] != "django" {
		t.Errorf("single image gave %v", got)
	}
	if IsComposite("sandbox-react") {
		t.Error("a prebuilt image was treated as a composite")
	}
}

// The heaviest toolchain becomes the base; the rest are layered onto it.
func TestComposeBaseSelection(t *testing.T) {
	cases := []struct{ stacks, base string }{
		{"django,react", "docker.io/library/python:3.11-slim-bookworm"},
		{"go,react", "docker.io/library/golang:1.22-bookworm"},
		{"java,node", "docker.io/library/eclipse-temurin:21-jdk-jammy"},
		{"node,python", "docker.io/library/python:3.11-slim-bookworm"},
		{"dotnet,react", "mcr.microsoft.com/dotnet/sdk:8.0"},
		// static has no toolchain of its own, so node still picks the base.
		{"react,static", "docker.io/library/node:20-bookworm-slim"},
	}
	for _, c := range cases {
		base, _ := composePlan(strings.Split(c.stacks, ","))
		if base != c.base {
			t.Errorf("composePlan(%s) base = %q, want %q", c.stacks, base, c.base)
		}
	}
}

func TestCompositeDockerfileInstallsEveryToolchain(t *testing.T) {
	df := CompositeDockerfile([]string{"react", "django"})

	if !strings.HasPrefix(df, "FROM docker.io/library/python:3.11-slim-bookworm") {
		t.Fatalf("unexpected base:\n%s", df)
	}
	// python is native to the base, so only node has to be layered on.
	if !strings.Contains(df, "deb.nodesource.com") {
		t.Error("node was never installed — the frontend service could not run")
	}
	// django is a package set on top of whichever python the base provided.
	if !strings.Contains(df, `"django>=4.2,<6"`) {
		t.Error("django was not installed")
	}
	if strings.Count(df, "FROM ") != 1 {
		t.Errorf("expected a single-stage build:\n%s", df)
	}
}

// Every stack the detector can emit must be buildable — either it is a base, or a layer fragment exists to install it.
func TestEveryStackCanBeComposed(t *testing.T) {
	for _, e := range Images {
		stack := ImageToStack(e.Image)
		tc := toolchain(stack)
		if tc == "" {
			continue // static: served by whatever base is present
		}
		if layer(tc) == "" && !isBase(tc) {
			t.Errorf("stack %q has no layers/%s.dockerfile and is not a base image", stack, tc)
		}
		df := CompositeDockerfile([]string{stack, "node"})
		if !strings.HasPrefix(df, "FROM ") {
			t.Errorf("stack %q produced a Dockerfile with no base:\n%s", stack, df)
		}
	}
}

func isBase(tc string) bool {
	for _, b := range basePriority {
		if b.Toolchain == tc {
			return true
		}
	}
	return false
}

// The Oracle Ampere VM is arm64, so a layer that downloads one architecture's binary breaks every image built there.
func TestNoLayerPinsAnArchitecture(t *testing.T) {
	pinned := regexp.MustCompile(`(?i)amd64|x86_64|aarch64|linux-x64`)
	entries, _ := layerFS.ReadDir("layers")
	for _, e := range entries {
		b, _ := layerFS.ReadFile("layers/" + e.Name())
		if m := pinned.FindString(string(b)); m != "" {
			t.Errorf("%s pins %q", e.Name(), m)
		}
	}
	dirs, _ := os.ReadDir(filepath.Join("..", "..", "sandbox-images"))
	for _, d := range dirs {
		b, err := os.ReadFile(filepath.Join("..", "..", "sandbox-images", d.Name(), "Dockerfile"))
		if err == nil && pinned.Match(b) {
			t.Errorf("sandbox-images/%s/Dockerfile pins an architecture", d.Name())
		}
	}
	if df := CompositeDockerfile([]string{"java", "go"}); !strings.Contains(df, "dpkg --print-architecture") {
		t.Errorf("composite go layer does not pick its arch:\n%s", df)
	}
}
