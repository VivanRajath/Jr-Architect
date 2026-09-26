package core

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// p-<token> is the primary service, p-<token>-<n> the nth entry of Services.
var previewLabel = regexp.MustCompile(`^p-([0-9a-f]{32})(?:-([0-9]{1,2}))?$`)

// 128 random bits: a preview URL is a bearer capability, so it cannot be derived from the container name.
func NewPreviewToken() string {
	return randomHex(16)
}

// Without JR_PREVIEW_DOMAIN previews stay on the loopback port, which only the server's own machine can open.
func PreviewURL(token string, n, hostPort int) string {
	if hostPort == 0 {
		return ""
	}
	if Cfg.PreviewDomain == "" || token == "" {
		return fmt.Sprintf("http://127.0.0.1:%d", hostPort)
	}
	label := "p-" + token
	if n > 0 {
		label += "-" + strconv.Itoa(n)
	}
	u := Cfg.PreviewScheme + "://" + label + "." + Cfg.PreviewDomain
	if !Cfg.Public() {
		u += ":" + Cfg.ListenPort()
	}
	return u + "/"
}

// Empty until that preview's tunnel is live, which the IDE already treats as "still starting".
func previewURLFor(sb Sandbox, n, hostPort int) string {
	if hostPort == 0 {
		return ""
	}
	if QuickTunnels() {
		if host := tunnelHost(sb.Container, n); host != "" {
			return "https://" + host + "/"
		}
		return ""
	}
	return PreviewURL(sb.PreviewToken, n, hostPort)
}

// The URL for one of sb's services, numbered the way PreviewTarget resolves it.
func ServicePreviewURL(sb Sandbox, svc Service) string {
	if svc.HostPort != 0 && svc.HostPort == sb.Port {
		return previewURLFor(sb, 0, svc.HostPort)
	}
	for i, s := range sb.Services {
		if s.Name == svc.Name {
			return previewURLFor(sb, i+1, svc.HostPort)
		}
	}
	return ""
}

func PrimaryPreviewURL(sb Sandbox) string {
	return previewURLFor(sb, 0, sb.Port)
}

// isPreview is true for any host that belongs to previews, so an unknown one gets a 404 rather than the IDE.
func ResolvePreviewHost(host string) (sb Sandbox, svc Service, isPreview, ok bool) {
	if QuickTunnels() {
		h := strings.ToLower(host)
		if hh, _, err := net.SplitHostPort(h); err == nil {
			h = hh
		}
		if !strings.HasSuffix(h, quickTunnelSuffix) {
			return Sandbox{}, Service{}, false, false
		}
		container, n, found := tunnelTarget(h)
		if !found {
			return Sandbox{}, Service{}, true, false
		}
		s, _ := GetSandbox(container)
		if s.PreviewToken == "" {
			return Sandbox{}, Service{}, true, false
		}
		sb, svc, ok = PreviewTarget(s.PreviewToken, n)
		return sb, svc, true, ok
	}
	token, n, parsed := ParsePreviewHost(host)
	if !parsed {
		return Sandbox{}, Service{}, false, false
	}
	sb, svc, ok = PreviewTarget(token, n)
	return sb, svc, true, ok
}

func ParsePreviewHost(host string) (token string, n int, ok bool) {
	if Cfg.PreviewDomain == "" {
		return "", 0, false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	label, found := strings.CutSuffix(host, "."+Cfg.PreviewDomain)
	if !found {
		return "", 0, false
	}
	m := previewLabel.FindStringSubmatch(label)
	if m == nil {
		return "", 0, false
	}
	if m[2] != "" {
		n, _ = strconv.Atoi(m[2])
		if n == 0 {
			return "", 0, false
		}
	}
	return m[1], n, true
}

// The sandbox and service a preview host points at.
func PreviewTarget(token string, n int) (Sandbox, Service, bool) {
	for _, sb := range AllSandboxes() {
		if sb.PreviewToken == "" || sb.PreviewToken != token {
			continue
		}
		// sb.Port is whatever the preview opens, even when the detected primary was switched off.
		if n == 0 {
			for _, svc := range sb.Services {
				if sb.Port != 0 && svc.HostPort == sb.Port {
					return sb, svc, true
				}
			}
			return Sandbox{}, Service{}, false
		}
		if n <= len(sb.Services) {
			return sb, sb.Services[n-1], true
		}
	}
	return Sandbox{}, Service{}, false
}
