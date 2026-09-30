package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/gorilla/websocket"

	"sandbox/internal/core"
)

type TerminalExecRequest struct {
	Container string `json:"container"`
	Command   string `json:"command"`
	TimeoutMs int    `json:"timeoutMs"`
}

func terminalExecHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req TerminalExecRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		core.JSONError(w, "invalid JSON", 400)
		return
	}
	_, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		core.JSONError(w, "command required", 400)
		return
	}
	res := core.ExecInContainer(req.Container, req.Command, time.Duration(req.TimeoutMs)*time.Millisecond)
	w.Header().Set("Content-Type", "application/json")
	// 200 means "the command ran" — whether it succeeded is res.exitCode.
	json.NewEncoder(w).Encode(res)
}

// Go reads Content-Type from the OS — on Windows, a registry any installer can

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser client (e.g. CLI); no CSRF surface
		}
		return core.IsAllowedOrigin(origin)
	},
}

// waitForContainerRunning blocks until the named Docker container exists and is
// running, or the timeout elapses. It streams a friendly notice to the terminal
// while waiting so the panel doesn't look dead. Returns false on timeout or if
// the container has already exited/died.
func waitForContainerRunning(ctx context.Context, cli *client.Client, name string, conn *websocket.Conn, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	notified := false
	for {
		info, err := cli.ContainerInspect(ctx, name)
		if err == nil && info.State != nil {
			if info.State.Running {
				return true
			}
			if info.State.Status == "exited" || info.State.Status == "dead" {
				conn.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[sandbox container exited before the shell could attach — check the setup logs]\x1b[0m\r\n"))
				return false
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		if !notified {
			conn.WriteMessage(websocket.TextMessage, []byte("\x1b[90mWaiting for the sandbox container to start…\x1b[0m\r\n"))
			notified = true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func terminalWSHandler(w http.ResponseWriter, r *http.Request) {
	containerName := r.URL.Query().Get("container")
	_, ok := ownedSandbox(w, r, containerName)
	if !ok {
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// Talk to the Docker Engine API directly instead of shelling out to
	// `docker exec` through a local PTY. On Windows the CLI-over-ConPTY path was
	// unreliable (docker.exe does its own raw-mode/IsTerminal handling that
	// fights the ConPTY wrapper, so keystrokes never reached the shell). The
	// Engine API's exec-attach hijack gives us a raw bidirectional TTY stream
	// that behaves identically on Windows, macOS and Linux.
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		core.AddLog(containerName, "terminal docker client failed: "+err.Error())
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to reach Docker: "+err.Error()+"\r\n"))
		return
	}
	defer cli.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The sandbox is registered in our map the instant /run begins, but the Docker
	// container is created asynchronously (after clone + runtime detection). A
	// terminal opened during that window would hit "No such container", so wait for
	// the container to be running before exec'ing a shell.
	// A first build of a new runtime can take minutes, and the IDE now opens before it finishes.
	if !waitForContainerRunning(ctx, cli, containerName, conn, 15*time.Minute) {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[sandbox did not start in time — reload the page to retry]\x1b[0m\r\n"))
		return
	}

	// Interactive login shell. Tty:true gives a real TTY inside the container so
	// prompts and character echo work. Prefer bash with a working-directory
	// prompt (\w) so `cd` visibly changes the path like VS Code; fall back to sh
	// with a $PWD prompt on slim images that lack bash (plain dash shows only a
	// bare "$" with no path, which made cd look like it did nothing).
	execResp, err := cli.ContainerExecCreate(ctx, containerName, container.ExecOptions{
		Tty:          true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		WorkingDir:   "/workspace",
		Env:          []string{"TERM=xterm-256color"},
		// Probe for bash with the redirect scoped to the probe only — do NOT
		// redirect bash's own stderr, or its prompt (written to stderr) vanishes
		// and the terminal looks dead. bash gives a \w (working-dir) prompt so
		// `cd` visibly changes the path; sh is the fallback with a $PWD prompt.
		Cmd: []string{"sh", "-c",
			"if command -v bash >/dev/null 2>&1; then export PS1='\\w \\$ '; exec bash --norc -i; else export PS1='$PWD $ '; exec sh -i; fi"},
	})
	if err != nil {
		core.AddLog(containerName, "terminal exec create failed: "+err.Error())
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to start shell: "+err.Error()+"\r\n"))
		return
	}

	att, err := cli.ContainerExecAttach(ctx, execResp.ID, container.ExecAttachOptions{Tty: true})
	if err != nil {
		core.AddLog(containerName, "terminal exec attach failed: "+err.Error())
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to attach shell: "+err.Error()+"\r\n"))
		return
	}
	defer att.Close()

	// exec output → websocket. With Tty:true the hijacked stream is a single raw
	// byte stream (no stdout/stderr multiplexing header), so we forward it as-is.
	go func() {
		buf := make([]byte, 4096)
		for {
			n, rerr := att.Reader.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		conn.Close() // unblock the read loop below
	}()

	// websocket → exec stdin. Binary frames carry keystrokes; text frames carry
	// resize events ({"type":"resize","cols":N,"rows":N}) so column-aware output
	// (ls, line wrapping) matches the visible terminal size.
readLoop:
	for {
		mt, msg, rerr := conn.ReadMessage()
		if rerr != nil {
			break
		}
		switch mt {
		case websocket.BinaryMessage:
			core.Touch(containerName)
			if _, werr := att.Conn.Write(msg); werr != nil {
				break readLoop
			}
		case websocket.TextMessage:
			var ev struct {
				Type string `json:"type"`
				Cols uint   `json:"cols"`
				Rows uint   `json:"rows"`
			}
			if json.Unmarshal(msg, &ev) == nil && ev.Type == "resize" && ev.Cols > 0 && ev.Rows > 0 {
				_ = cli.ContainerExecResize(ctx, execResp.ID, container.ResizeOptions{Height: ev.Rows, Width: ev.Cols})
			}
		}
	}
}

// startAgentService launches the Node.js agent service as a subprocess.
// It reads ANTHROPIC_API_KEY from the environment and passes it through.
