package core

import (
	"strings"
	"testing"
	"time"
)

func clearJREnv(t *testing.T) {
	for _, k := range []string{"JR_LISTEN_ADDR", "JR_PUBLIC_ORIGIN", "JR_PREVIEW_DOMAIN", "JR_PREVIEW_SCHEME", "JR_WORK_DIR",
		"JR_BETA_CODE", "JR_SESSION_SECRET", "JR_MAX_SANDBOXES", "JR_MAX_PER_USER", "JR_LLM_PER_HOUR",
		"JR_SANDBOX_IDLE_TTL", "JR_SANDBOX_MAX_TTL", "JR_SPAWN_AGENT", "AGENT_PORT",
		"JR_CONTAINER_CLI", "JR_PREHEAT_IMAGES", "JR_MIN_FREE_DISK_MB", "JR_INTERNAL_TOKEN", "JR_PREVIEW_MODE", "JR_CLOUDFLARED", "JR_DISK_CHECK_PATHS", "JR_SANDBOX_MAX_DISK_MB"} {
		t.Setenv(k, "")
	}
}

func TestLoadConfigDefaultsMatchLocalDev(t *testing.T) {
	clearJREnv(t)
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != "127.0.0.1:9000" || c.Public() || c.AuthEnabled() || c.PreviewDomain != "" {
		t.Fatalf("defaults drifted from local dev: %+v", c)
	}
	if c.MaxPerUser != 0 || c.LLMPerHour != 0 || !c.SpawnAgent || c.AgentPort != 8001 || c.ListenPort() != "9000" {
		t.Fatalf("local mode should not cap users or skip the agent: %+v", c)
	}
	if c.IdleTTL != 15*time.Minute || c.MaxTTL != 45*time.Minute {
		t.Fatalf("ttl defaults = %s/%s", c.IdleTTL, c.MaxTTL)
	}
}

func TestLoadConfigPublicMode(t *testing.T) {
	clearJREnv(t)
	t.Setenv("JR_PUBLIC_ORIGIN", "https://jr.example/")
	t.Setenv("JR_PREVIEW_DOMAIN", "JR.example.")
	t.Setenv("JR_BETA_CODE", "letmein")
	t.Setenv("JR_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("JR_SANDBOX_IDLE_TTL", "10m")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicOrigin != "https://jr.example" || c.PreviewDomain != "jr.example" || c.PreviewScheme != "https" {
		t.Fatalf("public origin/preview not normalised: %+v", c)
	}
	if c.MaxPerUser != 1 || c.LLMPerHour != 60 || c.IdleTTL != 10*time.Minute {
		t.Fatalf("public defaults not applied: %+v", c)
	}
}

func TestLoadConfigFailsClosed(t *testing.T) {
	cases := map[string]map[string]string{
		"public without login":   {"JR_PUBLIC_ORIGIN": "https://jr.example", "JR_PREVIEW_DOMAIN": "jr.example"},
		"public without preview": {"JR_PUBLIC_ORIGIN": "https://jr.example", "JR_BETA_CODE": "x", "JR_SESSION_SECRET": strings.Repeat("s", 32)},
		"short secret":           {"JR_BETA_CODE": "x", "JR_SESSION_SECRET": "short"},
		"idle above max":         {"JR_SANDBOX_IDLE_TTL": "50m"},
		"bad number":             {"JR_MAX_SANDBOXES": "lots"},
		"bad duration":           {"JR_SANDBOX_MAX_TTL": "soon"},
	}
	for name, env := range cases {
		t.Run(name, func(t *testing.T) {
			clearJREnv(t)
			for k, v := range env {
				t.Setenv(k, v)
			}
			if _, err := LoadConfig(); err == nil {
				t.Fatal("expected LoadConfig to refuse this configuration")
			}
		})
	}
}
