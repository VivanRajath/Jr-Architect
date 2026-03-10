package main

import (
	"log"
	"testing"
)

func TestStartSandbox(t *testing.T) {
	sb, err := startSandbox("https://github.com/VivanRajath/React-Portfolio", "")
	if err != nil {
		t.Fatal(err)
	}
	log.Printf("Started sandbox: %+v\n", sb)
}
