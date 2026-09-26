package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"sandbox/internal/core"
)

const testToken = "0123456789abcdef0123456789abcdef"

type seen struct{ host, origin, jrUser, cookie string }

func previewFixture(t *testing.T) (front *httptest.Server, got *seen) {
	t.Helper()
	withAuthConfig(t)
	got = &seen{}
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "http://localhost:5173" }}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = seen{r.Host, r.Header.Get("Origin"), r.Header.Get("X-Jr-User"), r.Header.Get("Cookie")}
		switch r.URL.Path {
		case "/ws":
			c, err := up.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			mt, msg, _ := c.ReadMessage()
			c.WriteMessage(mt, msg)
			c.Close()
		case "/go":
			http.SetCookie(w, &http.Cookie{Name: "app", Value: "1", Domain: "jr.example", Path: "/"})
			http.Redirect(w, r, "http://localhost:5173/login?next=1", http.StatusFound)
		default:
			fmt.Fprint(w, "hello from the app")
		}
	}))
	t.Cleanup(upstream.Close)
	u, _ := url.Parse(upstream.URL)
	var port int
	fmt.Sscan(u.Port(), &port)

	core.PutSandbox(core.Sandbox{Container: "sandbox-prev", Owner: "u-a", Port: port, PreviewToken: testToken,
		Services: []core.Service{{Name: "web", HostPort: port, ContainerPort: 5173, Primary: true}}})
	t.Cleanup(func() { core.DeleteSandbox("sandbox-prev") })

	mux := http.NewServeMux()
	Routes(mux, nil)
	front = httptest.NewServer(Front(mux))
	t.Cleanup(front.Close)
	return front, got
}

func getWithHost(t *testing.T, base, host, path string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", base+path, nil)
	req.Host = host
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPreviewProxiesToTheSandboxAsLocalhost(t *testing.T) {
	front, got := previewFixture(t)
	host := "p-" + testToken + ".jr.example"
	res := getWithHost(t, front.URL, host, "/", map[string]string{"Origin": "https://" + host, "X-Jr-User": "u-spoof", "Cookie": "app=1"})
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(body) != "hello from the app" {
		t.Fatalf("preview = %d %q", res.StatusCode, body)
	}
	if got.host != "localhost:5173" || got.origin != "http://localhost:5173" {
		t.Fatalf("app saw host=%q origin=%q, want localhost:5173", got.host, got.origin)
	}
	if got.jrUser != "" || got.cookie != "app=1" {
		t.Fatalf("app saw x-jr-user=%q cookie=%q; Jr headers must be stripped, the app's own cookies kept", got.jrUser, got.cookie)
	}
}

func TestPreviewRewritesRedirectsAndCookieDomains(t *testing.T) {
	front, _ := previewFixture(t)
	host := "p-" + testToken + ".jr.example"
	res := getWithHost(t, front.URL, host, "/go", nil)
	res.Body.Close()
	if loc := res.Header.Get("Location"); loc != "https://"+host+"/login?next=1" {
		t.Fatalf("Location = %q", loc)
	}
	for _, c := range res.Header.Values("Set-Cookie") {
		if strings.Contains(strings.ToLower(c), "domain=") {
			t.Fatalf("preview cookie kept its Domain: %q", c)
		}
	}
}

func TestPreviewTunnelsWebSockets(t *testing.T) {
	front, _ := previewFixture(t)
	host := "p-" + testToken + ".jr.example"
	wsURL := "ws" + strings.TrimPrefix(front.URL, "http") + "/ws"
	c, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Host": {host}, "Origin": {"https://" + host}})
	if err != nil {
		t.Fatalf("HMR-style socket through the preview failed: %v", err)
	}
	defer c.Close()
	c.WriteMessage(websocket.TextMessage, []byte("ping"))
	if _, msg, err := c.ReadMessage(); err != nil || string(msg) != "ping" {
		t.Fatalf("echo = %q %v", msg, err)
	}
}

func TestPreviewHostsNeverReachTheIDE(t *testing.T) {
	front, _ := previewFixture(t)
	cases := map[string]int{
		"p-" + strings.Repeat("f", 32) + ".jr.example": 404,
		"p-" + testToken + "-3.jr.example":             404,
		"p-" + testToken + ".jr.example":               200,
	}
	for host, want := range cases {
		res := getWithHost(t, front.URL, host, "/sandboxes", nil)
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("%s = %d, want %d", host, res.StatusCode, want)
		}
	}
	for _, host := range []string{"jr.example", "p-short.jr.example", "sandbox-prev.jr.example"} {
		res := getWithHost(t, front.URL, host, "/sandboxes", nil)
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Errorf("%s should be the IDE (401 without a session), got %d", host, res.StatusCode)
		}
	}
}

func TestPreviewURLs(t *testing.T) {
	old := core.Cfg
	defer func() { core.Cfg = old }()
	core.Cfg = core.DefaultConfig()
	if got := core.PreviewURL(testToken, 0, 5000); got != "http://127.0.0.1:5000" {
		t.Errorf("local default = %q, want the old loopback URL", got)
	}
	core.Cfg.PreviewDomain = "localhost"
	if got := core.PreviewURL(testToken, 2, 5000); got != "http://p-"+testToken+"-2.localhost:9000/" {
		t.Errorf("local host routing = %q", got)
	}
	core.Cfg.PublicOrigin, core.Cfg.PreviewDomain, core.Cfg.PreviewScheme = "https://jr.example", "jr.example", "https"
	if got := core.PreviewURL(testToken, 0, 5000); got != "https://p-"+testToken+".jr.example/" {
		t.Errorf("public = %q", got)
	}
	if core.PreviewURL(testToken, 0, 0) != "" {
		t.Error("a service with no port has no preview")
	}
	if a, b := core.NewPreviewToken(), core.NewPreviewToken(); len(a) != 32 || a == b {
		t.Errorf("tokens %q %q are not 128 random bits", a, b)
	}
}
