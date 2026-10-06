//go:build windows

package core

// Local development only; -1 means unknown and never blocks anything.
func diskFreeMB(string) int64 { return -1 }
