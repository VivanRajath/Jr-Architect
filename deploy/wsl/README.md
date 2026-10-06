# Jr-Arch public beta on one Windows machine

This runs Jr-Arch with rootless Podman inside a dedicated, locked-down WSL distro. It needs no cloud account, no domain and no card. It is a beta setup. The rest of this README says exactly what is validated and what is only assumed.

## Fresh machine, in order

### 1. Windows: `%USERPROFILE%\.wslconfig`

This file applies to every WSL distro on the machine.

```ini
[wsl2]
kernelCommandLine = cgroup_no_v1=all systemd.unified_cgroup_hierarchy=1
guiApplications = false
```

- **cgroup v2** is required. On v1, rootless Podman silently ignores `--memory`, `--cpus` and `--pids-limit`.
- **`guiApplications = false`** removes WSLg. WSLg bridges X11, Wayland, audio and the clipboard to the Windows desktop.

### 2. Windows PowerShell

```powershell
wsl --shutdown
wsl --install -d Ubuntu-24.04 --name jrarch --no-launch
```

Ubuntu 26.04 failed to start on WSL 2.4.13.

### 3. Runtime, as root

`setup-podman.sh` installs rootless Podman, the API socket, cloudflared and Node 22 for the user `jrarch`.

```powershell
wsl -d jrarch -u root -- bash /mnt/c/<repo>/deploy/wsl/setup-podman.sh jrarch
```

### 4. Hardening, as root, then restart the distro

`harden.sh` applies these controls:

- Windows interop off, and no Windows `PATH`.
- `C:` mounted root-only (`umask=077`).
- WSL default user set to `jrarch`.
- slirp4netns with `allow_host_loopback=false`.
- An nftables egress firewall on everything `jrarch` runs, sandboxes included.
- A preflight that refuses to start Jr-Arch if any of these controls is missing.

```powershell
wsl -d jrarch -u root -- bash /mnt/c/<repo>/deploy/wsl/harden.sh jrarch
wsl --terminate jrarch
```

### 4b. Storage pools, as root

```powershell
wsl -d jrarch -u root -- bash /mnt/c/<repo>/deploy/wsl/storage-pools.sh jrarch 10 20
```

This puts sandbox workdirs (10 GB) and Podman storage (20 GB: images, containers, per-sandbox caches) on fixed-size loop-mounted ext4 images. Sandboxes then can't fill the Windows drive.

- Mount options are `nosuid,nodev,discard`.
- The preflight refuses to start Jr-Arch unless both paths are these mounts.
- `JR_SANDBOX_MAX_DISK_MB` (default 3072 in public mode) reaps a single sandbox whose workdir grows past it, checked every 2 minutes. The pool is the hard limit between checks.

To let the WSL disk give freed space back to Windows, stop the distro and run `wsl --manage jrarch --set-sparse true`.

### 5. Install the app

Build on Windows, then run the installer as root:

```powershell
# in Git Bash:
#   GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o jr-linux .
wsl -d jrarch -u root -- bash /mnt/c/<repo>/deploy/wsl/install-runtime.sh /mnt/c/<repo> /mnt/c/<repo>/jr-linux jrarch
```

This writes `~jrarch/.config/jrarch/jrarch.env` (mode 600) with a fresh beta code and session secret, and enables the `jrarch.service` user unit. Rerun it to upgrade. The env file is never overwritten.

### 6. The IDE's public address (Tailscale Funnel, free)

Install Tailscale on Windows, sign in, then run:

```powershell
tailscale funnel --bg 9000
```

WSL forwards `localhost:9000` to the distro. Put the printed `https://<machine>.<tailnet>.ts.net` into `JR_PUBLIC_ORIGIN` in `jrarch.env`, and add your `GROQ_API_KEY`. Then:

```powershell
wsl -d jrarch --cd ~ -- systemctl --user restart jrarch
```

### 7. Keep it running

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
```

This registers the "JrArch Runtime" task. It starts at logon and re-checks every 5 minutes.

- Only one instance ever runs, so the re-check does nothing while the distro is up.
- Stop for a moment: `stop-jrarch.ps1` (the re-check restarts it within 5 minutes). Keep it stopped: `stop-jrarch.ps1 -Disable`. Remove the task: `stop-jrarch.ps1 -Uninstall`.
- Check state: `status.ps1`.

For recovery after a reboot, the Windows account must log on. Enable automatic sign-in if the machine should come back unattended. Power settings (plugged in):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

In Control Panel → Power Options → "Choose what closing the lid does", set **Do nothing** when plugged in.

### 8. Monitoring

Point UptimeRobot (free) at `/health` for liveness, and at `/ready` if you want alerts when the beta is full or low on disk.

## Health versus readiness

| Endpoint | Answers 200 when | 503 means |
|---|---|---|
| `/health` | the process is up | never returns 503. If there is no answer, the server is down |
| `/ready` | a new sandbox can be created now | `reasons` lists the problems: container engine or agent unreachable, below `JR_MIN_FREE_DISK_MB`, or at `JR_MAX_SANDBOXES` |

## Preview tunnels (Cloudflare quick tunnels)

Quick tunnels are Cloudflare's free, anonymous, **no-SLA** development tunnels. Treat them as beta infrastructure.

- A preview URL is published only after the tunnel has an edge connection and its name resolves.
- If cloudflared exits, the server opens a new tunnel and publishes the new URL. The IDE picks it up on its next status poll, and the old URL stops working.
- Preview URLs change whenever a tunnel is replaced or a sandbox restarts. Never share one as a permanent link.
- A quick-tunnel host that no longer maps to a live sandbox gets a 404 page. It never falls through to the IDE or its API.
- Destroying or reaping a sandbox closes its tunnels.
- Cloudflare may rate-limit or change quick tunnels at any time. The long-term fix is a domain with wildcard DNS (`JR_PREVIEW_DOMAIN`), which this server already supports.

## Checks you can rerun

Run these as `jrarch`:

| Command | What it does |
|---|---|
| `/usr/local/lib/jrarch/preflight.sh` | Checks every hardening control. Exits 1 if any is missing. |
| `LAN_IP=<windows LAN ip> ROUTER_IP=<router> bash ~/app/deploy/adversarial.sh [container]` | Attacks outward from a sandbox, with canary listeners so a "blocked" result means something |
| `bash ~/app/deploy/validate.sh` | Full lifecycle on real Podman. Pauses `jrarch.service` while it runs. |

## Docker Desktop mode: local development only

The default `JR_CONTAINER_CLI=docker` path runs natively on Windows against Docker Desktop. `deploy/windows/validate-docker.sh` validates it end to end:

```bash
CLOUDFLARED=/path/to/cloudflared.exe WORK=/path/to/empty/dir bash deploy/windows/validate-docker.sh
```

It isn't a public deployment target. On Docker Desktop, `host.docker.internal` reaches the host's loopback, so one sandbox can reach another sandbox's published dev-server port. The WSL firewall can't block that, because Docker Desktop runs in its own VM.

The Jr-Arch API still refuses a sandbox that gets there (401 without a session), and so does the agent (403 without Go's internal token). Run the public beta only on the hardened Podman distro above.
