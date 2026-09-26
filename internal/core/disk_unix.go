//go:build !windows

package core

import "syscall"

func diskFreeMB(dir string) int64 {
	var st syscall.Statfs_t
	if syscall.Statfs(dir, &st) != nil {
		return -1
	}
	return int64(st.Bavail) * int64(st.Bsize) / (1024 * 1024)
}
