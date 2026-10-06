package core

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Shared by the CORS layer and the WebSocket upgrade check so they can't drift.
func IsLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

// The IDE's own origin: exactly JR_PUBLIC_ORIGIN when public, any loopback origin locally.
func IsAllowedOrigin(origin string) bool {
	if Cfg.Public() {
		return strings.EqualFold(strings.TrimSuffix(origin, "/"), Cfg.PublicOrigin)
	}
	return IsLoopbackOrigin(origin)
}

// Echo an allowlisted Origin, never "*", so no other site can read the response.
func CORS(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Origin")
	if r == nil {
		return
	}
	origin := r.Header.Get("Origin")
	if origin == "" || !IsAllowedOrigin(origin) {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func JSONError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func FreePort() (int, error) {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func WaitForServer(port int) bool {
	client := http.Client{Timeout: 3 * time.Second}
	for range 300 {
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", port))
		if err == nil {
			ready := resp.StatusCode < 500
			resp.Body.Close()
			if ready {
				return true
			}
		}
		time.Sleep(1 * time.Second)
	}
	return false
}
