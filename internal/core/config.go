package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Every field defaults to what local development has always done, so an empty env changes nothing.
type Config struct {
	ListenAddr    string
	PublicOrigin  string // e.g. https://jrarch.duckdns.org; empty means local mode
	PreviewDomain string // previews live at p-<token>.<PreviewDomain>; empty keeps 127.0.0.1:<port>
	PreviewScheme string
	WorkDir       string
	BetaCode      string
	SessionSecret []byte
	MaxSandboxes  int // 0 means no cap
	MaxPerUser    int
	IdleTTL       time.Duration
	MaxTTL        time.Duration
	SpawnAgent    bool
	AgentPort     int
	LLMPerHour    int    // agent and builder calls per user per hour; 0 means no cap
	InternalToken string // lets the agent service call back into Go past the login gate
	ContainerCLI  string // "docker" or "podman"; both take the same arguments here
	PreheatImages []string
	MinFreeDiskMB int64  // new sandboxes are refused below this; 0 means no check
	PreviewMode   string // "" routes by PreviewDomain (or loopback); "quicktunnel" gives each preview a cloudflared host
	// Under WSL the workdir's filesystem is a sparse ~1TB disk, so the Windows drive has to be checked too.
	DiskCheckPaths []string
	Cloudflared    string
	// A sandbox whose workdir grows past this is reaped; 0 means no per-sandbox limit.
	MaxSandboxDiskMB int64
}

var Cfg = DefaultConfig()

func DefaultConfig() Config {
	return Config{
		ListenAddr:    "127.0.0.1:9000",
		PreviewScheme: "http",
		WorkDir:       os.TempDir(),
		MaxSandboxes:  6,
		IdleTTL:       15 * time.Minute,
		MaxTTL:        45 * time.Minute,
		SpawnAgent:    true,
		AgentPort:     8001,
		ContainerCLI:  "docker",
		Cloudflared:   "cloudflared",
	}
}

func (c Config) Public() bool      { return c.PublicOrigin != "" }
func (c Config) AuthEnabled() bool { return c.BetaCode != "" }

// The port the agent service calls back on.
func (c Config) ListenPort() string {
	_, port, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return "9000"
	}
	return port
}

func LoadConfig() (Config, error) {
	c := DefaultConfig()
	c.ListenAddr = envStr("JR_LISTEN_ADDR", c.ListenAddr)
	c.PublicOrigin = strings.TrimSuffix(envStr("JR_PUBLIC_ORIGIN", ""), "/")
	c.PreviewDomain = strings.ToLower(strings.Trim(envStr("JR_PREVIEW_DOMAIN", ""), "."))
	c.WorkDir = envStr("JR_WORK_DIR", c.WorkDir)
	c.BetaCode = envStr("JR_BETA_CODE", "")
	c.SessionSecret = []byte(envStr("JR_SESSION_SECRET", ""))
	c.InternalToken = envStr("JR_INTERNAL_TOKEN", "")
	c.ContainerCLI = envStr("JR_CONTAINER_CLI", c.ContainerCLI)
	c.PreviewMode = strings.ToLower(envStr("JR_PREVIEW_MODE", ""))
	c.Cloudflared = envStr("JR_CLOUDFLARED", c.Cloudflared)
	for _, p := range strings.Split(envStr("JR_DISK_CHECK_PATHS", ""), ",") {
		if p = strings.TrimSpace(p); p != "" {
			c.DiskCheckPaths = append(c.DiskCheckPaths, p)
		}
	}
	if v := envStr("JR_PREHEAT_IMAGES", ""); v != "" {
		c.PreheatImages = []string{}
		for _, name := range strings.Split(v, ",") {
			if name = strings.TrimSpace(name); name != "" && name != "none" {
				c.PreheatImages = append(c.PreheatImages, strings.TrimPrefix(name, "sandbox-"))
			}
		}
	}
	if c.Public() {
		c.PreviewScheme = "https"
		c.LLMPerHour = 60
		c.MinFreeDiskMB = 5120
		c.MaxSandboxDiskMB = 3072
	}
	if c.AuthEnabled() {
		c.MaxPerUser = 1
	}
	c.PreviewScheme = envStr("JR_PREVIEW_SCHEME", c.PreviewScheme)
	if c.PreviewMode == "quicktunnel" {
		c.PreviewScheme = "https"
	}

	var err error
	set := func(name string, dst *int) {
		if v := envStr(name, ""); v != "" && err == nil {
			n, e := strconv.Atoi(v)
			if e != nil || n < 0 {
				err = fmt.Errorf("%s must be a non-negative integer, got %q", name, v)
			}
			*dst = n
		}
	}
	setDur := func(name string, dst *time.Duration) {
		if v := envStr(name, ""); v != "" && err == nil {
			d, e := time.ParseDuration(v)
			if e != nil || d <= 0 {
				err = fmt.Errorf("%s must be a positive duration like 15m, got %q", name, v)
			}
			*dst = d
		}
	}
	set("JR_MAX_SANDBOXES", &c.MaxSandboxes)
	set("JR_MAX_PER_USER", &c.MaxPerUser)
	set("JR_LLM_PER_HOUR", &c.LLMPerHour)
	set("AGENT_PORT", &c.AgentPort)
	disk := int(c.MinFreeDiskMB)
	set("JR_MIN_FREE_DISK_MB", &disk)
	c.MinFreeDiskMB = int64(disk)
	perSandbox := int(c.MaxSandboxDiskMB)
	set("JR_SANDBOX_MAX_DISK_MB", &perSandbox)
	c.MaxSandboxDiskMB = int64(perSandbox)
	setDur("JR_SANDBOX_IDLE_TTL", &c.IdleTTL)
	setDur("JR_SANDBOX_MAX_TTL", &c.MaxTTL)
	if v := envStr("JR_SPAWN_AGENT", ""); v != "" {
		c.SpawnAgent = v != "0" && !strings.EqualFold(v, "false")
	}
	if err != nil {
		return c, err
	}
	// A spawned agent inherits a fresh token; a separately run one must share JR_INTERNAL_TOKEN.
	if c.InternalToken == "" && c.SpawnAgent {
		c.InternalToken = randomHex(32)
	}
	if abs, e := filepath.Abs(c.WorkDir); e == nil {
		c.WorkDir = abs
	}
	return c, c.Validate()
}

// A public server with a gap in its access control refuses to start rather than run open.
func (c Config) Validate() error {
	if c.IdleTTL > c.MaxTTL {
		return fmt.Errorf("JR_SANDBOX_IDLE_TTL (%s) cannot exceed JR_SANDBOX_MAX_TTL (%s)", c.IdleTTL, c.MaxTTL)
	}
	if c.AuthEnabled() && len(c.InternalToken) < 32 {
		return fmt.Errorf("JR_INTERNAL_TOKEN must be at least 32 characters when the agent runs as its own service")
	}
	if c.AuthEnabled() && len(c.SessionSecret) < 32 {
		return fmt.Errorf("JR_SESSION_SECRET must be at least 32 characters when JR_BETA_CODE is set")
	}
	if c.PreviewMode != "" && c.PreviewMode != "quicktunnel" {
		return fmt.Errorf("JR_PREVIEW_MODE must be empty or quicktunnel, got %q", c.PreviewMode)
	}
	if c.ContainerCLI != "docker" && c.ContainerCLI != "podman" {
		return fmt.Errorf("JR_CONTAINER_CLI must be docker or podman, got %q", c.ContainerCLI)
	}
	for _, name := range c.PreheatImages {
		if ImageBuildDir("sandbox-"+name) == "" {
			return fmt.Errorf("JR_PREHEAT_IMAGES names %q, which is not a sandbox image", name)
		}
	}
	if !c.Public() {
		return nil
	}
	if !strings.HasPrefix(c.PublicOrigin, "https://") && !strings.HasPrefix(c.PublicOrigin, "http://") {
		return fmt.Errorf("JR_PUBLIC_ORIGIN must be an http(s) origin, got %q", c.PublicOrigin)
	}
	if !c.AuthEnabled() {
		return fmt.Errorf("JR_PUBLIC_ORIGIN is set but JR_BETA_CODE is not: a public server needs a login")
	}
	if c.PreviewDomain == "" && c.PreviewMode != "quicktunnel" {
		return fmt.Errorf("JR_PUBLIC_ORIGIN is set but neither JR_PREVIEW_DOMAIN nor JR_PREVIEW_MODE=quicktunnel is: previews would point at 127.0.0.1")
	}
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func envStr(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}
