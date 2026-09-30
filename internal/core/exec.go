package core

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// Bounds on a one-shot command. Without them a model-authored command can hang a request forever or flood the response with a gigabyte of build output.
const (
	ExecDefaultTimeout = 120 * time.Second
	ExecMaxTimeout     = 10 * time.Minute
	ExecMaxOutputBytes = 256 * 1024
)

// ExecResult carries enough for a caller to tell success from failure.
type ExecResult struct {
	Output    string `json:"output"`
	ExitCode  int    `json:"exitCode"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
}

// ExecInContainer runs a shell command inside the container's workspace.
func ExecInContainer(container, command string, timeout time.Duration) ExecResult {
	if timeout <= 0 {
		timeout = ExecDefaultTimeout
	}
	if timeout > ExecMaxTimeout {
		timeout = ExecMaxTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	c := exec.CommandContext(ctx, CLI(), "exec", "-w", "/workspace", container, "sh", "-c", command)
	out, err := c.CombinedOutput()

	res := ExecResult{Output: string(out)}
	// Keep the tail: the error a command died on is at the end, not the start.
	if len(out) > ExecMaxOutputBytes {
		res.Output = "…[output truncated]…\n" + string(out[len(out)-ExecMaxOutputBytes:])
		res.Truncated = true
	}
	if ctx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
		res.ExitCode = 124
		return res
	}
	var ee *exec.ExitError
	switch {
	case errors.As(err, &ee):
		res.ExitCode = ee.ExitCode()
	case err != nil:
		res.ExitCode = -1
		if strings.TrimSpace(res.Output) == "" {
			res.Output = err.Error()
		}
	}
	return res
}
