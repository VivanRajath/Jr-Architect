# ADR-004: GitHub credentials never enter an environment that runs repository code

Status: accepted. Fixes W-01 in `docs/PRODUCTION_AUDIT.md`.

## Context

Pull, commit, push and the git graph ran `git` inside the user's sandbox container (`docker exec`), with the GitHub token in that git process's environment. That container also runs the repository's own code as the same user: its dev server, its `postinstall` scripts, and whatever the agent's `shell` tool runs. Such code can read `/proc/<pid>/environ` of the git process. It can also make git leak the token without racing for it, by planting `.git/hooks/pre-push`, `core.fsmonitor`, `filter.*.clean`, a `credential.helper`, or an `http.proxy`; git honours all of these from `.git/config`. The token has `repo` scope, so one leak exposes every repository the user can reach.

Command-line overrides (`-c core.hooksPath=/dev/null` and similar) are not enough on their own: a URL-specific key such as `http.https://github.com/owner/.proxy` in the repository's config can still win over a generic override.

## Decision

1. Git operations are split by whether they need the token.
   - Status, log, show, add, commit, checkout and rebase run in the sandbox through `runGit`. It accepts only a `localEnv`, a struct that `localGitEnv` builds without a token parameter, so the compiler rejects any attempt to pass token-bearing config.
   - Fetch and push run through `secureRemoteGit`.
2. `secureRemoteGit` starts a fresh `alpine/git` container per operation, with `--cap-drop ALL`, `no-new-privileges`, and pid and memory limits. Inside it, git works in a scratch git directory (`GIT_DIR=/tmp/g`) whose config is ours. The workspace's objects are borrowed as data through `objects/info/alternates`. The workspace's `.git/config`, hooks and filters are never read. Hooks are off, `alternateRefsCommand` is neutralised, and only `https` may leave.
3. Refs and shallow boundaries go into that container as validated text in a control directory that only Go and the container mount.
   - The refs are read by tokenless git in the sandbox and re-checked against a strict pattern.
   - The shallow file is read via `os.Root`, and only hashes are kept.
4. Fetched packs, remote-tracking refs and the shallow file come back through Go using `os.Root`, so a symlink planted in `.git` cannot redirect a write. File names and ref names are checked against strict patterns.
5. The repository a push goes to comes from the server's record: `Sandbox.GitHub` (set at publish), then the clone URL. A workspace's `origin` is used only when neither exists (a saved project reopened). A push to an origin that differs from the server's record is refused.
6. A pull is a secure fetch followed by a tokenless rebase in the sandbox.

## Alternatives

- **Run git on the host.** Rejected: repository config and hooks would then execute on the host.
- **Overrides only, still inside the sandbox.** Rejected: `/proc` snooping and URL-specific config keys defeat it.
- **Push through the GitHub REST API** (create blobs, trees and commits). Sound and dependency-free, but a larger rewrite. It also loses git's pack negotiation for big pushes. Worth revisiting if the git container becomes a burden.

## Trade-offs

- Each fetch or push starts a container, which adds a second or two.
- The `alpine/git` image is pulled from Docker Hub by tag. Pinning it by digest is a follow-up.
- Remote-tracking refs are written as loose refs. A stale *packed* remote ref for a branch deleted upstream survives a prune.

## Consequences

- Repository-controlled code never shares an environment with the token. `TestTokenNeverReachesRepositoryControlledCode` plants hooks, fsmonitor, filters, proxies and a credential helper, then pushes and fetches through the new path, and asserts the token was never seen. Its control step proves the same traps do catch the old in-workspace push.
- The real container path was exercised under rootless Podman with the `alpine/git` image (fetch, unshallow, packs and refs returned).
- Clone still runs on the host with the token (`hostClone`). Clone does not execute repository hooks or config, and no repository code has run yet at that point.
