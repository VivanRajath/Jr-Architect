// What a model-chosen shell command may do: the model proposes, this decides. Deny is final; ask needs a server-held approval from the user.

// Commands that let code steer the git that later runs with credentials, read other processes' secrets, or reach the container engine.
const DENY = [
  [/\.git\/(hooks|config|info\/|objects\/info\/alternates)/, "it edits git internals (hooks, config or alternates)"],
  [/\bgit\b[^|;&]*\s(-c\s|--config-env|config\b)/, "it changes git configuration"],
  [/\bgit\b[^|;&]*\sremote\s+(add|set-url|rename)\b/, "it rewires a git remote"],
  [/\bgit\b[^|;&]*\s(push|filter-branch|filter-repo|update-ref)\b/, "pushing and history rewrites go through Source Control, not the agent"],
  [/\bGIT_(DIR|CONFIG\w*|SSH\w*|ASKPASS)\s*=/, "it overrides git's environment"],
  [/\/proc\/[^\s]*\/(environ|mem|root)\b/, "it reads another process's memory or environment"],
  [/(docker|podman)\.sock|\b(docker|podman|nsenter|unshare|mount|chroot)\b/, "it reaches for the container engine or namespaces"],
  [/\bsudo\b|\bsu\s+-?\w*/, "it asks for root"],
  [/~\/\.ssh|\/root\/\.ssh|\bssh-keygen\b|\bid_(rsa|ed25519)\b/, "it touches SSH keys"],
];

// Commands that can do lasting damage or send data off the machine; the user sees them first.
const ASK = [
  [/\b(curl|wget|nc|ncat|netcat|ssh|scp|rsync|ftp|telnet)\b/, "it talks to the network"],
  [/\|\s*(sh|bash|zsh|python3?|node|perl|ruby)\b/, "it pipes something into an interpreter"],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|rm|uninstall|update|up|upgrade)\s+\S/, "it changes dependencies"],
  [/\b(pip3?|uv|poetry|gem|cargo|go)\s+(install|add|get|remove|uninstall)\b/, "it changes dependencies"],
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r|-r\s+-f|-f\s+-r)\b|\brm\s+-\w*r\w*\s+\/(\s|$)/, "it deletes a tree"],
  [/\bgit\b[^|;&]*\s(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore\s+\.)/, "it discards work"],
  [/\b(nohup|setsid|disown|crontab|at\s+now)\b|&\s*$/, "it leaves a process running"],
  [/\bchmod\s+(-R\s+)?[0-7]*7[0-7]{2}\b|\bchown\b/, "it changes permissions or ownership"],
  [/\b(eval|exec)\b/, "it runs constructed code"],
];

// Returns { action: "allow" | "ask" | "deny", reason }.
export function classifyCommand(command) {
  const c = String(command || "").trim();
  if (!c) return { action: "deny", reason: "the command is empty" };
  if (c.length > 4000) return { action: "deny", reason: "the command is too long to review" };
  for (const [re, reason] of DENY) if (re.test(c)) return { action: "deny", reason };
  for (const [re, reason] of ASK) if (re.test(c)) return { action: "ask", reason };
  return { action: "allow", reason: "" };
}

// Folds an OpenGAP verdict in: a sealed or blocking hook denies, a warning or checkpoint asks.
export function withGuard(decision, guard) {
  if (!guard) return decision;
  if (guard.blocked && guard.blocked.length) {
    return { action: "deny", reason: guard.blocked.map((b) => `${b.hook}: ${b.reason}`).join("; ") };
  }
  if (decision.action === "allow" && guard.warnings && guard.warnings.length) {
    return { action: "ask", reason: guard.warnings.map((w) => `${w.hook}: ${w.reason}`).join("; ") };
  }
  return decision;
}
