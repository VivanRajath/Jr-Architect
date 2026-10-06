package core

import (
	"fmt"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const cloudflaredLog = `2026-09-27T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-27T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-09-27T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-27T10:00:01Z INF |  https://rough-snow-lamp-1234.trycloudflare.com                                           |
2026-09-27T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-09-27T10:00:03Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=bom01 protocol=quic
`

func TestScanTunnelOutputWaitsForARegisteredConnection(t *testing.T) {
	found := make(chan string, 1)
	scanTunnelOutput(strings.NewReader(cloudflaredLog), found)
	if got := <-found; got != "rough-snow-lamp-1234.trycloudflare.com" {
		t.Fatalf("host = %q", got)
	}
	notReady := make(chan string, 1)
	scanTunnelOutput(strings.NewReader(strings.SplitN(cloudflaredLog, "Registered", 2)[0]), notReady)
	if len(notReady) != 0 {
		t.Fatal("published a host before the tunnel had an edge connection")
	}
}

func quickTunnelFixture(t *testing.T) *int32 {
	t.Helper()
	resetRegistry(t)
	old, oldLaunch, oldDelay := Cfg, launchTunnel, tunnelRetryDelay
	Cfg = DefaultConfig()
	Cfg.PreviewMode = "quicktunnel"
	tunnelRetryDelay = time.Millisecond
	var n int32
	launchTunnel = func() (string, *exec.Cmd, <-chan struct{}, error) {
		i := atomic.AddInt32(&n, 1)
		return fmt.Sprintf("host-%d.trycloudflare.com", i), nil, nil, nil
	}
	t.Cleanup(func() {
		Cfg, launchTunnel, tunnelRetryDelay = old, oldLaunch, oldDelay
		tunnelMu.Lock()
		tunnels = map[string]map[int]*tunnel{}
		tunnelMu.Unlock()
	})
	return &n
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}

func TestQuickTunnelPerServiceRoutingAndClose(t *testing.T) {
	launched := quickTunnelFixture(t)
	calls := stubDocker(t)
	_ = calls
	sb := Sandbox{Container: "sandbox-qt", Port: 5001, PreviewToken: NewPreviewToken(), Status: StatusRunning,
		Services: []Service{{Name: "web", HostPort: 5001, Primary: true}, {Name: "api", HostPort: 5002}, {Name: "worker"}}}
	PutSandbox(sb)

	if PrimaryPreviewURL(sb) != "" {
		t.Fatal("a preview URL was published before its tunnel existed")
	}
	OpenPreviews("sandbox-qt")
	waitFor(t, func() bool { return tunnelHost("sandbox-qt", 0) != "" && tunnelHost("sandbox-qt", 2) != "" })
	if atomic.LoadInt32(launched) != 2 {
		t.Fatalf("launched %d tunnels, want one per HTTP service (2)", *launched)
	}

	primary := PrimaryPreviewURL(sb)
	host := strings.TrimSuffix(strings.TrimPrefix(primary, "https://"), "/")
	got, svc, isPreview, ok := ResolvePreviewHost(host)
	if !isPreview || !ok || got.Container != "sandbox-qt" || svc.Name != "web" {
		t.Fatalf("%s resolved to %v %v %v %v", host, got.Container, svc.Name, isPreview, ok)
	}
	api := strings.TrimSuffix(strings.TrimPrefix(ServicePreviewURL(sb, sb.Services[1]), "https://"), "/")
	if _, svc, _, ok := ResolvePreviewHost(api); !ok || svc.Name != "api" {
		t.Fatalf("api host %q resolved to %q", api, svc.Name)
	}
	if _, _, isPreview, ok := ResolvePreviewHost("stale-host.trycloudflare.com"); !isPreview || ok {
		t.Fatal("an unknown quick tunnel host must be a preview 404, never the IDE")
	}
	if _, _, isPreview, _ := ResolvePreviewHost("inspiron.tail1234.ts.net"); isPreview {
		t.Fatal("the IDE host was treated as a preview")
	}

	Reap(sb, "test")
	if tunnelHost("sandbox-qt", 0) != "" {
		t.Fatal("reaping left the tunnel registered")
	}
	if _, _, _, ok := ResolvePreviewHost(host); ok {
		t.Fatal("a reaped sandbox's preview host still resolves")
	}
}

func TestTunnelFinishingAfterReapIsDropped(t *testing.T) {
	quickTunnelFixture(t)
	release := make(chan struct{})
	launchTunnel = func() (string, *exec.Cmd, <-chan struct{}, error) {
		<-release
		return "late.trycloudflare.com", nil, nil, nil
	}
	PutSandbox(Sandbox{Container: "sandbox-late", Port: 1, Services: []Service{{Name: "web", HostPort: 1}}})
	OpenPreviews("sandbox-late")
	DeleteSandbox("sandbox-late")
	close(release)
	time.Sleep(50 * time.Millisecond)
	if _, _, ok := tunnelTarget("late.trycloudflare.com"); ok {
		t.Fatal("a tunnel that came up after its sandbox was reaped stayed registered")
	}
}

func TestQuickTunnelConfig(t *testing.T) {
	clearJREnv(t)
	t.Setenv("JR_PREVIEW_MODE", "")
	t.Setenv("JR_PUBLIC_ORIGIN", "https://inspiron.tail1234.ts.net")
	t.Setenv("JR_BETA_CODE", "x")
	t.Setenv("JR_SESSION_SECRET", strings.Repeat("s", 32))
	if _, err := LoadConfig(); err == nil {
		t.Fatal("public mode with neither a preview domain nor quick tunnels must be refused")
	}
	t.Setenv("JR_PREVIEW_MODE", "quicktunnel")
	c, err := LoadConfig()
	if err != nil || c.PreviewScheme != "https" {
		t.Fatalf("quicktunnel config: %v %+v", err, c)
	}
	t.Setenv("JR_PREVIEW_MODE", "ngrok")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("an unknown preview mode must be refused")
	}
}

func TestDeadTunnelIsReplaced(t *testing.T) {
	quickTunnelFixture(t)
	deaths := []chan struct{}{make(chan struct{}), make(chan struct{})}
	var launches int32
	launchTunnel = func() (string, *exec.Cmd, <-chan struct{}, error) {
		i := atomic.AddInt32(&launches, 1)
		return fmt.Sprintf("gen-%d.trycloudflare.com", i), nil, deaths[i-1], nil
	}
	PutSandbox(Sandbox{Container: "sandbox-dies", Port: 1, Services: []Service{{Name: "web", HostPort: 1}}})
	OpenPreviews("sandbox-dies")
	waitFor(t, func() bool { return tunnelHost("sandbox-dies", 0) == "gen-1.trycloudflare.com" })

	close(deaths[0])
	waitFor(t, func() bool { return tunnelHost("sandbox-dies", 0) == "gen-2.trycloudflare.com" })
	if _, _, ok := tunnelTarget("gen-1.trycloudflare.com"); ok {
		t.Fatal("the dead tunnel's host still routes")
	}

	CloseTunnels("sandbox-dies")
	DeleteSandbox("sandbox-dies")
	close(deaths[1])
	time.Sleep(30 * time.Millisecond)
	if atomic.LoadInt32(&launches) != 2 {
		t.Fatal("a tunnel we closed on purpose was replaced")
	}
}
