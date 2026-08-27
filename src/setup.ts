// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
// `modula-relay setup <harness>` installs the always-armed pieces for one harness in the
// current folder: loop instructions, cancellation-safe hooks, and tool pre-trust. Every
// write is guarded by a marker or key check, so re-running is a no-op and existing user
// configuration is never clobbered — a piece that cannot be applied safely is reported
// with manual instructions instead.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const MARKER = '<!-- modula-relay:armed -->'

const CLAUDE_LOOP = `${MARKER}
This project uses Modula Relay for agent-to-agent messaging. From your FIRST turn and at
all times: stay reachable on relay. Loop: call relay_await (timeout_ms 30000) for inbound
requests or replies; when a request arrives, handle it and answer with relay_reply; when a
reply arrives, act on it; then resume relay_await. After TWO consecutive empty timeouts,
END YOUR TURN with a one-line status — the installed Stop hook wakes you whenever messages
queue, so yielding never loses anything and keeps you instantly responsive to the human.
Never wait to be told to listen.
`

const CODEX_LOOP = `${MARKER}
This project uses Modula Relay for agent-to-agent messaging. From your FIRST turn and at
all times: stay armed on relay. Loop: call relay_await (timeout_ms 30000) for inbound
requests or replies; when a request arrives, handle it and answer with relay_reply; then
immediately resume relay_await. Peers may message you at any moment — an empty await
simply means resume waiting. Only pause the loop when the human asks you something
directly; resume it right after. Never wait to be told to listen.
`

const SETUP_USAGE = `Usage: modula-relay setup <claude|codex> [--name <peer-name>]

Installs the always-armed pieces for one harness in the current folder:
  claude   .claude/settings.json Stop hook + relay tool trust, CLAUDE.md loop
  codex    $CODEX_HOME/config.toml relay server + tool trust, AGENTS.md loop`

type Report = { lines: string[]; next: string[] }

export function runSetup(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const harness = argv[0]
  const name = flagValue(argv, '--name')
  const report: Report = { lines: [], next: [] }
  if (harness === 'claude') setupClaude(cwd, report)
  else if (harness === 'codex') setupCodex(cwd, env, name ?? 'verifier', report)
  else throw new Error(SETUP_USAGE)
  const next = report.next.length ? `\nNext:\n${report.next.map(step => `  ${step}`).join('\n')}` : ''
  return `${report.lines.map(line => `  ${line}`).join('\n')}${next}`
}

function setupClaude(cwd: string, report: Report) {
  appendLoop(path.join(cwd, 'CLAUDE.md'), CLAUDE_LOOP, report)
  const claudeDir = path.join(cwd, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const hookTarget = path.join(claudeDir, 'relay-stop-hook.sh')
  if (existsSync(hookTarget)) report.lines.push(`kept   ${relative(cwd, hookTarget)} (already present)`)
  else { copyFileSync(packagedExample('claude-stop-hook.sh'), hookTarget); report.lines.push(`wrote  ${relative(cwd, hookTarget)}`) }
  mergeClaudeSettings(path.join(claudeDir, 'settings.json'), cwd, report)
  report.next.push('claude mcp add relay -- npx -y @modulastack/relay --name coder')
}

function mergeClaudeSettings(file: string, cwd: string, report: Report) {
  let settings: Record<string, any> = {}
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, 'utf8')) }
    catch {
      report.lines.push(`SKIP   ${relative(cwd, file)} is not valid JSON — add the Stop hook and "mcp__relay" permission manually`)
      return
    }
  }
  // $CLAUDE_PROJECT_DIR keeps the hook working when the project moves.
  const command = 'bash "$CLAUDE_PROJECT_DIR/.claude/relay-stop-hook.sh"'
  const stops: any[] = (settings.hooks ??= {}).Stop ??= []
  const hookInstalled = stops.some(entry => (entry?.hooks ?? []).some((hook: any) => hook?.command === command))
  if (!hookInstalled) stops.push({ hooks: [{ type: 'command', command }] })
  const allow: string[] = (settings.permissions ??= {}).allow ??= []
  const trustInstalled = allow.includes('mcp__relay')
  if (!trustInstalled) allow.push('mcp__relay')
  if (hookInstalled && trustInstalled) { report.lines.push(`kept   ${relative(cwd, file)} (already configured)`); return }
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  report.lines.push(`merged ${relative(cwd, file)} (Stop hook + relay tool trust)`)
}

function setupCodex(cwd: string, env: NodeJS.ProcessEnv, name: string, report: Report) {
  appendLoop(path.join(cwd, 'AGENTS.md'), CODEX_LOOP, report)
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex')
  mkdirSync(home, { recursive: true })
  const file = path.join(home, 'config.toml')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (/^\[mcp_servers\.relay\]/m.test(existing)) {
    report.lines.push(`kept   ${file} (a [mcp_servers.relay] entry already exists — ensure it carries default_tools_approval_mode = "auto")`)
    return
  }
  const block = `\n[mcp_servers.relay]\ndefault_tools_approval_mode = "auto"\ncommand = "npx"\nargs = ["-y", "@modulastack/relay", "--name", ${JSON.stringify(name)}]\n`
  writeFileSync(file, `${existing}${block}`)
  report.lines.push(`merged ${file} (relay server as "${name}" + tool trust)`)
}

function appendLoop(file: string, block: string, report: Report) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const label = path.basename(file)
  if (existing.includes(MARKER)) { report.lines.push(`kept   ${label} (already armed)`); return }
  writeFileSync(file, existing ? `${existing.replace(/\n*$/, '\n\n')}${block}` : block)
  report.lines.push(`${existing ? 'append' : 'wrote '} ${label} (always-armed loop)`)
}

function packagedExample(filename: string) {
  return fileURLToPath(new URL(`../examples/${filename}`, import.meta.url))
}

function flagValue(argv: string[], flag: string) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

function relative(cwd: string, target: string) {
  return path.relative(cwd, target) || target
}
