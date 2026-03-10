package main

import (
	"fmt"
	"path/filepath"
)

func main() {
	workdir := `C:\Users\VIVANR~1\AppData\Local\Temp\sandbox-2507621586`
	container := "sandbox-sandbox-2507621586"
	port := 55555
	runtimeConfigPort := 3000
	runtimeConfigImage := "sandbox-node"
	runtimeConfigStartupCommand := "npm install && npm start"

	abs, _ := filepath.Abs(workdir)

	args := []string{
		"run",
		"-d",
		"--name", container,
		"--memory", "512m",
		"--cpus", "1",
		"--pids-limit", "100",
		"-p", fmt.Sprintf("0.0.0.0:%d:%d", port, runtimeConfigPort),
		"-v", fmt.Sprintf("%s:/workspace", abs),
		"-w", "/workspace",
		"-e", "PORT=" + fmt.Sprintf("%d", runtimeConfigPort),
		runtimeConfigImage,
		"sh", "-c", runtimeConfigStartupCommand,
	}

	for i, arg := range args {
		fmt.Printf("Arg %d: %q\n", i, arg)
	}
}
