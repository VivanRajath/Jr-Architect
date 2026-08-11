#!/usr/bin/env node
// jr-architect review --base main
//
// Reads .gitagent/pipeline.json, clones the packs it names, applies them to a diff.
// Exit 1 on a denial, which is all a CI gate needs. No IDE, server or Docker.

import { reviewRange } from "./review.js";

const USAGE = `jr-architect — run a repository's own GitAgent pipeline

USAGE
  jr-architect review [options]

OPTIONS
  --base <ref>     what to compare against            (default: origin/main)
  --head <ref>     what to review                     (default: HEAD)
  --dir <path>     the repository                     (default: .)
  --message <s>    what the change is meant to do; the packs see it
  --json           machine-readable output
  --github         emit ::error:: annotations for GitHub Actions
  --no-fail        always exit 0, even when a pack denies
  -h, --help

EXIT CODES
  0  nothing denied
  1  a guardrail denied at least one file
  2  the review could not run (bad ref, not a repo)

ENVIRONMENT
  GROQ_API_KEY (or ANTHROPIC/OPENAI/GEMINI)   required for pack review;
                                              without one only the code-level
                                              floor runs, and that still gates
  GITAGENT_GUARDRAIL_FAIL=closed              treat an unreachable pack as a
                                              denial — recommended in CI
`;

function parseArgs(argv) {
  const out = { base: "origin/main", head: "HEAD", dir: ".", message: "", json: false, github: false, fail: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") out.base = next();
    else if (a === "--head") out.head = next();
    else if (a === "--dir") out.dir = next();
    else if (a === "--message" || a === "-m") out.message = next();
    else if (a === "--json") out.json = true;
    else if (a === "--github") out.github = true;
    else if (a === "--no-fail") out.fail = false;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) { out.error = `unknown option ${a}`; }
    else out.positional = (out.positional || []).concat(a);
  }
  return out;
}

// Plain on purpose: this lands in CI logs as often as a terminal.
function printHuman(res, opts) {
  const line = (s = "") => process.stdout.write(s + "\n");

  line();
  line(`  ${opts.base}...${opts.head}${res.commit ? ` (${res.commit})` : ""}`);
  line(`  ${res.total} changed file(s) · ${res.verdicts.length} reviewed · ${res.skipped.length} skipped`);
  line(`  packs: ${res.packs && res.packs.length ? res.packs.join(", ") : "(none assigned — code floor only)"}`);
  line();

  for (const v of res.verdicts) {
    if (v.decision === "deny") line(`  DENY   ${v.path}\n         ${v.reason}`);
    // "unreviewed" is not "ok" — nothing looked at this file.
    else if (v.decision === "unreviewed") line(`  ??     ${v.path}\n         unreviewed — ${v.reason}`);
    else line(`  ok     ${v.path}`);
  }

  if (res.skipped.length) {
    line();
    for (const s of res.skipped) line(`  --     ${s.path} (${s.why})`);
  }

  line();
  if (res.auditPath) line(`  logged to ${res.auditPath}`);
  line(res.ok && res.reviewed === false
    ? `  PASS — but nothing was reviewed by a pack; the code floor alone gated this`
    : res.ok
    ? `  PASS — nothing denied`
    : `  FAIL — ${res.denied.length} file(s) denied by a guardrail`);
  line();
}

function printGitHub(res) {
  for (const v of res.verdicts) {
    if (v.decision !== "deny") continue;
    // Renders as an annotation on the file in the PR's Files tab.
    const msg = String(v.reason || "denied by a guardrail").replace(/\r?\n/g, " ");
    process.stdout.write(`::error file=${v.path},title=GitAgent guardrail::${msg}\n`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd !== "review") {
    process.stderr.write(`jr-architect: unknown command "${cmd}"\n\n${USAGE}`);
    return 2;
  }

  const opts = parseArgs(argv.slice(1));
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.error) { process.stderr.write(`jr-architect: ${opts.error}\n`); return 2; }

  let res;
  try {
    res = await reviewRange({
      dir: opts.dir,
      base: opts.base,
      head: opts.head,
      message: opts.message,
      // Steps go to stderr so `--json` on stdout stays pipeable.
      onStep: opts.json ? null : (name, detail) => process.stderr.write(`  ${name}: ${detail}\n`),
    });
  } catch (e) {
    process.stderr.write(`jr-architect: ${e.message}\n`);
    return 2;
  }

  if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  else printHuman(res, opts);
  if (opts.github) printGitHub(res);

  return res.ok || !opts.fail ? 0 : 1;
}

process.exitCode = await main();
