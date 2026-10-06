package core

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func resetRegistry(t *testing.T) {
	t.Helper()
	mutex.Lock()
	saved := sandboxes
	sandboxes = map[string]Sandbox{}
	mutex.Unlock()
	t.Cleanup(func() {
		mutex.Lock()
		sandboxes = saved
		mutex.Unlock()
	})
}

func TestAddSandboxEnforcesCaps(t *testing.T) {
	resetRegistry(t)
	if err := AddSandbox(Sandbox{Container: "a1", Owner: "a"}, 2, 1); err != nil {
		t.Fatal(err)
	}
	if err := AddSandbox(Sandbox{Container: "a2", Owner: "a"}, 2, 1); err != ErrUserLimit {
		t.Fatalf("second sandbox for one user = %v, want ErrUserLimit", err)
	}
	if err := AddSandbox(Sandbox{Container: "b1", Owner: "b"}, 2, 1); err != nil {
		t.Fatal(err)
	}
	if err := AddSandbox(Sandbox{Container: "c1", Owner: "c"}, 2, 1); err != ErrAtCapacity {
		t.Fatalf("third user past the global cap = %v, want ErrAtCapacity", err)
	}
	UpdateSandbox("b1", func(s *Sandbox) { s.Status = StatusFailed })
	if err := AddSandbox(Sandbox{Container: "c1", Owner: "c"}, 2, 1); err != nil {
		t.Fatalf("a failed sandbox should free its slot: %v", err)
	}
	if sb, _ := GetSandbox("c1"); sb.CreatedAt.IsZero() || sb.LastActive.IsZero() {
		t.Fatal("AddSandbox should stamp CreatedAt and LastActive")
	}
	if err := AddSandbox(Sandbox{Container: "x", Owner: "x"}, 0, 0); err != nil {
		t.Fatalf("zero caps mean unlimited: %v", err)
	}
}

func TestAddSandboxNeverOvershootsUnderContention(t *testing.T) {
	resetRegistry(t)
	var ok int32
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if AddSandbox(Sandbox{Container: fmt.Sprintf("s%d", i), Owner: fmt.Sprintf("u%d", i)}, 6, 1) == nil {
				atomic.AddInt32(&ok, 1)
			}
		}(i)
	}
	wg.Wait()
	if ok != 6 || len(AllSandboxes()) != 6 {
		t.Fatalf("admitted %d sandboxes (%d stored), want exactly 6", ok, len(AllSandboxes()))
	}
}
