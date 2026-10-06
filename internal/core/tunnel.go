package core

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Quick tunnels need no account or domain, and each gets its own random host, so every preview is its own site.
const quickTunnelSuffix = ".trycloudflare.com"

var tunnelURL = regexp.MustCompile(`https://([a-z0-9-]+\.trycloudflare\.com)`)

type tunnel struct {
	host string
	cmd  *exec.Cmd
}

var (
	tunnelMu sync.Mutex
	tunnels  = map[string]map[int]*tunnel{} // container -> preview number -> tunnel
)

func QuickTunnels() bool { return Cfg.PreviewMode == "quicktunnel" }

// The public host once cloudflared has a live edge connection; the URL alone can still 530 for a few seconds.
func scanTunnelOutput(r io.Reader, found chan<- string) {
	sc := bufio.NewScanner(r)
	host := ""
	for sc.Scan() {
		line := sc.Text()
		if host == "" {
			if m := tunnelURL.FindStringSubmatch(line); m != nil {
				host = m[1]
			}
		}
		if host != "" && strings.Contains(line, "Registered tunnel connection") {
			select {
			case found <- host:
			default:
			}
		}
	}
}

// Swapped in tests. The tunnel points at our own listener, which routes by the Host cloudflared forwards.
var launchTunnel = func() (string, *exec.Cmd, <-chan struct{}, error) {
	cmd := exec.Command(Cfg.Cloudflared, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:"+Cfg.ListenPort())
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return "", nil, nil, err
	}
	found := make(chan string, 1)
	exited := make(chan struct{})
	go func() {
		scanTunnelOutput(stderr, found)
		cmd.Wait()
		close(exited)
	}()
	select {
	case host := <-found:
		waitForDNS(host, 60*time.Second)
		return host, cmd, exited, nil
	case <-exited:
		return "", nil, nil, errors.New("cloudflared exited before registering a tunnel")
	case <-time.After(60 * time.Second):
		cmd.Process.Kill()
		return "", nil, nil, errors.New("cloudflared did not register a tunnel within 60s")
	}
}

// Asks 1.1.1.1 directly: a browser that looks the name up too early caches the miss for minutes.
func waitForDNS(host string, limit time.Duration) {
	r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "udp", "1.1.1.1:53")
	}}
	for end := time.Now().Add(limit); time.Now().Before(end); time.Sleep(2 * time.Second) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		addrs, err := r.LookupHost(ctx, host)
		cancel()
		if err == nil && len(addrs) > 0 {
			return
		}
	}
	Logf("preview", "%s still does not resolve after %s, publishing anyway", host, limit)
}

var tunnelRetryDelay = 10 * time.Second

// Starts a tunnel for every service that serves HTTP; the preview URL appears once each one is live.
func OpenPreviews(container string) {
	if !QuickTunnels() {
		return
	}
	sb, ok := GetSandbox(container)
	if !ok {
		return
	}
	for i, svc := range sb.Services {
		if svc.HostPort == 0 {
			continue
		}
		n := i + 1
		if svc.HostPort == sb.Port {
			n = 0
		}
		go openTunnel(container, n)
	}
}

func openTunnel(container string, n int) {
	for attempt := 1; attempt <= 3; attempt++ {
		host, cmd, exited, err := launchTunnel()
		if err == nil {
			tunnelMu.Lock()
			// Reap deletes the sandbox before closing its tunnels, so a late tunnel is either closed there or here.
			if _, alive := GetSandbox(container); !alive {
				tunnelMu.Unlock()
				killTunnel(cmd)
				return
			}
			if tunnels[container] == nil {
				tunnels[container] = map[int]*tunnel{}
			}
			t := &tunnel{host: host, cmd: cmd}
			tunnels[container][n] = t
			tunnelMu.Unlock()
			Logf("preview", "tunnel for %s #%d at https://%s", container, n, host)
			go replaceWhenDead(container, n, t, exited)
			return
		}
		Logf("preview", "tunnel for %s #%d failed (attempt %d): %v", container, n, attempt, err)
		time.Sleep(time.Duration(attempt) * tunnelRetryDelay)
	}
}

// A tunnel we did not close has died, so the sandbox gets a new one; the IDE picks up the new URL on its next poll.
func replaceWhenDead(container string, n int, t *tunnel, exited <-chan struct{}) {
	if exited == nil {
		return
	}
	<-exited
	tunnelMu.Lock()
	current := tunnels[container][n] == t
	if current {
		delete(tunnels[container], n)
	}
	tunnelMu.Unlock()
	if _, alive := GetSandbox(container); !current || !alive {
		return
	}
	Logf("preview", "tunnel for %s #%d (%s) exited, opening a new one", container, n, t.host)
	time.Sleep(tunnelRetryDelay)
	openTunnel(container, n)
}

func killTunnel(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
}

func CloseTunnels(container string) {
	tunnelMu.Lock()
	defer tunnelMu.Unlock()
	for _, t := range tunnels[container] {
		killTunnel(t.cmd)
	}
	delete(tunnels, container)
}

func tunnelHost(container string, n int) string {
	tunnelMu.Lock()
	defer tunnelMu.Unlock()
	if t, ok := tunnels[container][n]; ok {
		return t.host
	}
	return ""
}

func tunnelTarget(host string) (string, int, bool) {
	tunnelMu.Lock()
	defer tunnelMu.Unlock()
	for container, byN := range tunnels {
		for n, t := range byN {
			if t.host == host {
				return container, n, true
			}
		}
	}
	return "", 0, false
}
