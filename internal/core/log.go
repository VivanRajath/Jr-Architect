package core

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var (
	setupLogs = map[string]*strings.Builder{}
	logsMutex sync.Mutex
)

func AddLog(container, msg string) {
	logsMutex.Lock()
	defer logsMutex.Unlock()
	if _, ok := setupLogs[container]; !ok {
		setupLogs[container] = &strings.Builder{}
	}
	fmt.Fprintf(setupLogs[container], "[%s] %s\n", time.Now().Format("15:04:05"), msg)
	fmt.Println(msg)
}

func DropLogs(container string) {
	logsMutex.Lock()
	defer logsMutex.Unlock()
	delete(setupLogs, container)
}

func LogsFor(container string) (string, bool) {
	logsMutex.Lock()
	defer logsMutex.Unlock()
	b, ok := setupLogs[container]
	if !ok {
		return "", false
	}
	return b.String(), true
}

func Run(container, cmd string, args ...string) error {
	if container != "" {
		AddLog(container, fmt.Sprintf("Running: %s %v", cmd, args))
	}
	c := exec.Command(cmd, args...)
	out, err := c.CombinedOutput()
	if err != nil {
		if container != "" {
			AddLog(container, fmt.Sprintf("Error: %v\nOutput: %s", err, string(out)))
		} else {
			fmt.Println(string(out))
		}
	}
	return err
}

func Output(container, cmd string, args ...string) (string, error) {
	if container != "" {
		AddLog(container, fmt.Sprintf("Running: %s %v", cmd, args))
	}
	c := exec.Command(cmd, args...)
	out, err := c.CombinedOutput()
	return string(out), err
}

// One-line server log with a component tag, so journalctl can be grepped by area.
func Logf(component, format string, args ...interface{}) {
	fmt.Printf("%s [%s] %s\n", time.Now().Format("2006-01-02T15:04:05"), component, fmt.Sprintf(format, args...))
}
