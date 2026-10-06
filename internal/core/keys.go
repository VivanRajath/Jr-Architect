package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Provider struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Env    string `json:"env"`
	Prefix string `json:"prefix"`
}

// Anthropic sits before OpenAI because "sk-ant-" also starts with "sk-".
var Providers = []Provider{
	{"groq", "Groq", "GROQ_API_KEY", "gsk_"},
	{"anthropic", "Anthropic", "ANTHROPIC_API_KEY", "sk-ant-"},
	{"openai", "OpenAI", "OPENAI_API_KEY", "sk-"},
	{"gemini", "Gemini", "GEMINI_API_KEY", "AIza"},
}

func ProviderByID(id string) (Provider, bool) {
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

func DetectProvider(key string) (Provider, bool) {
	key = strings.TrimSpace(key)
	for _, p := range Providers {
		if strings.HasPrefix(key, p.Prefix) {
			return p, true
		}
	}
	return Provider{}, false
}

// A user may save this many keys per provider.
const MaxKeysPerProvider = 10

// Keys saved in Settings are tried first, strongest provider first; the server's .env keys are the fallback, Groq first.
var (
	userOrder   = []string{"anthropic", "openai", "gemini", "groq"}
	systemOrder = []string{"groq", "anthropic", "openai", "gemini"}
)

var (
	keysMu sync.Mutex
	// The .env keys as they were at startup, before any saved key replaced them in this process's environment.
	systemKeys map[string][]string
)

func keysFile() string { return filepath.Join(Cfg.DataDir, "keys.json") }

// keys.json maps a provider to a list of keys; a plain string is the single-key format from before.
func readSavedKeys() map[string][]string {
	out := map[string][]string{}
	raw := map[string]json.RawMessage{}
	if data, err := os.ReadFile(keysFile()); err == nil {
		json.Unmarshal(data, &raw)
	}
	for id, v := range raw {
		var list []string
		if json.Unmarshal(v, &list) != nil {
			var one string
			if json.Unmarshal(v, &one) == nil && one != "" {
				list = []string{one}
			}
		}
		if _, ok := ProviderByID(id); ok && len(list) > 0 {
			out[id] = list
		}
	}
	return out
}

func writeSavedKeys(keys map[string][]string) error {
	if err := os.MkdirAll(Cfg.DataDir, 0700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(keys, "", "  ")
	tmp := keysFile() + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, keysFile())
}

func appendUnique(list []string, keys ...string) []string {
	for _, k := range keys {
		if k = strings.TrimSpace(k); k != "" && !contains(list, k) {
			list = append(list, k)
		}
	}
	return list
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Groq also reads GROQ_API_KEYS (comma-separated) and GROQ_API_KEY_2..10.
func envKeys(p Provider) []string {
	var keys []string
	if p.ID == "groq" {
		keys = appendUnique(keys, strings.Split(os.Getenv("GROQ_API_KEYS"), ",")...)
	}
	keys = appendUnique(keys, os.Getenv(p.Env))
	if p.ID == "groq" {
		for i := 2; i <= 10; i++ {
			keys = appendUnique(keys, os.Getenv(fmt.Sprintf("GROQ_API_KEY_%d", i)))
		}
	}
	return keys
}

func systemKeysLocked() map[string][]string {
	if systemKeys == nil {
		systemKeys = map[string][]string{}
		for _, p := range Providers {
			systemKeys[p.ID] = envKeys(p)
		}
	}
	return systemKeys
}

// Runs once at startup, after .env is read and before the agent service inherits the environment.
func LoadSavedKeys() {
	keysMu.Lock()
	defer keysMu.Unlock()
	systemKeysLocked()
	applyEnvLocked(readSavedKeys())
}

// Each provider's env var holds its first effective key, for code that reads only one.
func applyEnvLocked(saved map[string][]string) {
	for _, p := range Providers {
		if keys := effectiveLocked(p.ID, saved); len(keys) > 0 {
			os.Setenv(p.Env, keys[0])
		} else {
			os.Unsetenv(p.Env)
		}
	}
}

func effectiveLocked(id string, saved map[string][]string) []string {
	if len(saved[id]) > 0 {
		return saved[id]
	}
	return systemKeysLocked()[id]
}

// The keys a call to this provider should rotate through: the user's if they saved any, else the server's.
func ProviderKeys(id string) []string {
	keysMu.Lock()
	defer keysMu.Unlock()
	return append([]string(nil), effectiveLocked(id, readSavedKeys())...)
}

func orderLocked(saved map[string][]string) []string {
	var out []string
	for _, id := range userOrder {
		if len(saved[id]) > 0 {
			out = append(out, id)
		}
	}
	for _, id := range systemOrder {
		if !contains(out, id) && len(systemKeysLocked()[id]) > 0 {
			out = append(out, id)
		}
	}
	return out
}

// What the agent service needs: only the user's keys, since it already holds the server's own.
func AgentKeys() map[string][]string {
	keysMu.Lock()
	defer keysMu.Unlock()
	saved := readSavedKeys()
	out := map[string][]string{}
	for _, p := range Providers {
		out[p.ID] = append([]string{}, saved[p.ID]...)
	}
	return out
}

type SavedKey struct {
	ID     string `json:"id"`
	Masked string `json:"masked"`
}

type KeyState struct {
	Provider
	Configured bool       `json:"configured"`
	Keys       []SavedKey `json:"keys"`
	// Keys from the server's .env, used only while the user has saved none for this provider.
	System       int    `json:"system"`
	SystemMasked string `json:"systemMasked,omitempty"`
	Source       string `json:"source,omitempty"`
	Masked       string `json:"masked,omitempty"`
	Model        string `json:"model"`
	// 1 for the provider requests go to first, 0 when it has no key.
	Rank int `json:"rank"`
}

func KeyStates() []KeyState {
	keysMu.Lock()
	defer keysMu.Unlock()
	saved := readSavedKeys()
	order := orderLocked(saved)
	out := make([]KeyState, 0, len(Providers))
	for _, p := range Providers {
		s := KeyState{Provider: p, Keys: []SavedKey{}, Model: ProviderModel(p.ID)}
		sys := systemKeysLocked()[p.ID]
		s.System = len(sys)
		if len(sys) > 0 {
			s.SystemMasked = MaskKey(sys[0])
		}
		for _, k := range saved[p.ID] {
			s.Keys = append(s.Keys, SavedKey{ID: KeyID(k), Masked: MaskKey(k)})
		}
		switch {
		case len(s.Keys) > 0:
			s.Configured, s.Source, s.Masked = true, "saved", s.Keys[0].Masked
		case s.System > 0:
			s.Configured, s.Source, s.Masked = true, "env", s.SystemMasked
		}
		for i, id := range order {
			if id == p.ID {
				s.Rank = i + 1
			}
		}
		out = append(out, s)
	}
	return out
}

func MaskKey(k string) string {
	if len(k) < 12 {
		return "••••"
	}
	return k[:4] + "…" + k[len(k)-4:]
}

// A stable handle for one saved key that does not reveal it.
func KeyID(k string) string {
	sum := sha256.Sum256([]byte(k))
	return hex.EncodeToString(sum[:6])
}

// Adds a key to the provider's list; saving one that is already there is not an error.
func AddSavedKey(id, key string) error {
	p, ok := ProviderByID(id)
	if !ok {
		return fmt.Errorf("unknown provider %q", id)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("the key is empty")
	}
	keysMu.Lock()
	defer keysMu.Unlock()
	keys := readSavedKeys()
	if contains(keys[id], key) {
		return nil
	}
	if len(keys[id]) >= MaxKeysPerProvider {
		return fmt.Errorf("%s already has %d keys; remove one first", p.Label, MaxKeysPerProvider)
	}
	keys[id] = append(keys[id], key)
	return saveLocked(keys)
}

// Removes one saved key by its KeyID, or all of the provider's saved keys when keyID is empty.
func RemoveSavedKey(id, keyID string) error {
	if _, ok := ProviderByID(id); !ok {
		return fmt.Errorf("unknown provider %q", id)
	}
	keysMu.Lock()
	defer keysMu.Unlock()
	keys := readSavedKeys()
	var kept []string
	for _, k := range keys[id] {
		if keyID != "" && KeyID(k) != keyID {
			kept = append(kept, k)
		}
	}
	if keyID != "" && len(kept) == len(keys[id]) {
		return fmt.Errorf("that key is not saved")
	}
	if len(kept) == 0 {
		delete(keys, id)
	} else {
		keys[id] = kept
	}
	return saveLocked(keys)
}

func saveLocked(keys map[string][]string) error {
	if err := writeSavedKeys(keys); err != nil {
		return err
	}
	applyEnvLocked(keys)
	return nil
}

// The model Build mode uses with each provider; JR_MODEL_<PROVIDER> overrides it.
func ProviderModel(id string) string {
	if v := strings.TrimSpace(os.Getenv("JR_MODEL_" + strings.ToUpper(id))); v != "" {
		return v
	}
	switch id {
	case "anthropic":
		return "claude-opus-5-5"
	case "openai":
		return "gpt-5.2"
	case "gemini":
		return "gemini-2.5-pro"
	default:
		return "openai/gpt-oss-120b"
	}
}

type KeyCheck string

const (
	KeyValid      KeyCheck = "valid"
	KeyRejected   KeyCheck = "rejected"
	KeyUnverified KeyCheck = "unverified"
)

// One models-list call to the provider; only a 401/403 proves the key is bad.
func CheckKey(p Provider, key string) (KeyCheck, string) {
	var req *http.Request
	switch p.ID {
	case "groq":
		req, _ = http.NewRequest("GET", "https://api.groq.com/openai/v1/models", nil)
		req.Header.Set("Authorization", "Bearer "+key)
	case "openai":
		req, _ = http.NewRequest("GET", "https://api.openai.com/v1/models", nil)
		req.Header.Set("Authorization", "Bearer "+key)
	case "anthropic":
		req, _ = http.NewRequest("GET", "https://api.anthropic.com/v1/models", nil)
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "gemini":
		req, _ = http.NewRequest("GET", "https://generativelanguage.googleapis.com/v1beta/models", nil)
		req.Header.Set("x-goog-api-key", key)
	default:
		return KeyUnverified, "unknown provider"
	}
	res, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return KeyUnverified, "could not reach " + p.Label
	}
	res.Body.Close()
	switch {
	case res.StatusCode == 200:
		return KeyValid, ""
	case res.StatusCode == 401 || res.StatusCode == 403:
		return KeyRejected, p.Label + " rejected this key"
	default:
		return KeyUnverified, fmt.Sprintf("%s answered %d", p.Label, res.StatusCode)
	}
}
