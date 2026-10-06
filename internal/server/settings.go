package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"sandbox/internal/builder"
	"sandbox/internal/core"
)

// A public server shares its keys with every beta user, so changing them there takes an explicit opt-in.
func keysEditable() bool {
	return !core.Cfg.Public() || os.Getenv("JR_KEYS_EDITABLE") == "true"
}

func keysHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"providers": core.KeyStates(), "editable": keysEditable()})
	case http.MethodPost:
		llmLimited(saveKeyHandler)(w, r)
	default:
		core.JSONError(w, "method not allowed", 405)
	}
}

type keyRequest struct {
	Key      string `json:"key"`
	Provider string `json:"provider"`
	Remove   string `json:"remove"`
}

func readKeyRequest(w http.ResponseWriter, r *http.Request) (keyRequest, core.Provider, bool) {
	var req keyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return req, core.Provider{}, false
	}
	req.Key = strings.TrimSpace(req.Key)
	p, ok := core.ProviderByID(req.Provider)
	if !ok && req.Key != "" {
		p, ok = core.DetectProvider(req.Key)
	}
	if !ok {
		core.JSONError(w, "could not tell which provider this key is for; keys start with gsk_ (Groq), sk-ant- (Anthropic), sk- (OpenAI) or AIza (Gemini)", 400)
		return req, core.Provider{}, false
	}
	return req, p, true
}

func keyTestHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	req, p, ok := readKeyRequest(w, r)
	if !ok {
		return
	}
	if req.Key == "" {
		core.JSONError(w, "paste a key to test", 400)
		return
	}
	check, note := core.CheckKey(p, req.Key)
	writeJSON(w, map[string]any{"provider": p, "check": check, "note": note})
}

func saveKeyHandler(w http.ResponseWriter, r *http.Request) {
	if !keysEditable() {
		core.JSONError(w, "API keys on this server are managed by its administrator", 403)
		return
	}
	req, p, ok := readKeyRequest(w, r)
	if !ok {
		return
	}
	check, note := core.KeyUnverified, ""
	var err error
	if req.Key == "" {
		err = core.RemoveSavedKey(p.ID, req.Remove)
	} else if check, note = core.CheckKey(p, req.Key); check == core.KeyRejected {
		core.JSONError(w, note, 400)
		return
	} else {
		err = core.AddSavedKey(p.ID, req.Key)
	}
	if err != nil {
		core.JSONError(w, err.Error(), 400)
		return
	}
	builder.ResetGroqPool()
	pushKeysToAgent()
	writeJSON(w, map[string]any{"provider": p, "check": check, "note": note, "providers": core.KeyStates()})
}

// The agent service holds its own copy of the keys, so a change has to reach it directly; it may be down, which is fine.
func pushKeysToAgent() {
	body, _ := json.Marshal(map[string]any{"keys": core.AgentKeys()})
	req, err := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/agent/keys", core.Cfg.AgentPort), bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jr-Internal", core.Cfg.InternalToken)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		core.Logf("settings", "could not update the agent service's keys: %v", err)
		return
	}
	res.Body.Close()
}
