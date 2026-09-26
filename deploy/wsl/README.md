# Jr-Arch on rootless Podman in WSL

For running Jr-Arch on a Windows machine with no Docker Desktop, no cloud account and no domain.

## 1. Windows side (once)

Rootless Podman needs cgroup v2 to enforce `--memory`, `--cpus` and `--pids-limit`. WSL's default kernel boots with v1, which makes those flags no-ops. Create `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
kernelCommandLine = cgroup_no_v1=all systemd.unified_cgroup_hierarchy=1
```

Then, in PowerShell:

```powershell
wsl --shutdown
wsl --install -d Ubuntu-24.04 --name jrarch --no-launch
```

Ubuntu 26.04 did not start on WSL 2.4.13 (`Wsl/Service/E_UNEXPECTED`); 24.04 does.

## 2. Inside the distro

```powershell
wsl -d jrarch -u root -- bash /mnt/c/path/to/sandbox-runner/deploy/wsl/setup-podman.sh jrarch
```

The script does the following:

- Stops with a clear message on low disk, missing systemd or cgroup v1.
- Installs Podman, passt, slirp4netns, uidmap and cloudflared. If the distro's Node is older than 20, it installs Node 22 from nodejs.org and verifies the checksum.
- Creates the `jrarch` user with subuids, delegates the cgroup controllers and enables linger.
- Makes `/` a shared mount on every boot.
- Starts `podman.socket` and checks `podman info`, `podman ps`, `podman run` and the API `/_ping`.

It prints the env lines Jr-Arch needs: `JR_CONTAINER_CLI=podman`, `DOCKER_HOST=unix:///run/user/<uid>/podman/podman.sock`, `JR_WORK_DIR`, and `JR_PREHEAT_IMAGES`.

Inside WSL, `df /` reports the sparse virtual disk (about 1 TB), not your real free space. Set `JR_DISK_CHECK_PATHS=/mnt/c` so that the disk floor and `/health` measure the Windows drive.

## 3. Build and stage

Build on Windows, from the repo root:

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o jr-linux .
```

Stage the build into `/home/jrarch/app` as follows:

- Copy `jr-linux` to `/home/jrarch/app/jr`.
- Copy `sandbox-images/` alongside it.
- Copy `agent-services/*.js` and `package*.json`, then run `npm ci` there. Always run `npm ci` inside WSL, and never copy a Windows `node_modules`.

## 4. Validate

WSL stops a distro when no Windows-side process is attached. During validation, and in production through Task Scheduler, keep a session open with `wsl -d jrarch -u jrarch -- sleep infinity`. Then run the two suites:

```powershell
wsl -d jrarch -u jrarch -- bash /mnt/c/path/to/sandbox-runner/deploy/wsl/validate.sh
```

`validate.sh` drives the real HTTP API end to end. It covers sandboxes on real repos, the terminal, previews through Cloudflare, the networking matrix, destroy and cleanup, failed builds, the startup reaper and the disk floor.

The Go integration tests run against real Podman and skip everywhere else. Build them on Windows first:

```bash
GOOS=linux go test -c -o core-it.test ./internal/core
```

Then run them in WSL as `jrarch`:

```bash
JR_PODMAN_IT=1 XDG_RUNTIME_DIR=/run/user/$(id -u) ./core-it.test -test.run Podman -test.v
```
