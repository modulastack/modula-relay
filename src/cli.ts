#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { RelayAdapter, wakeEnabledForRole } from './relayAdapter.js'
import { configureRelayHost } from './host.js'
import { RELAY_MCP_CONTRACT_VERSION } from './relayContract.js'
import { startRelayServer } from './relayServer.js'

const USAGE = `Usage: modula-relay --name <peer-name> [--project <pool>] [--dir <runtime-dir>] [--purpose <text>] [--model <label>]
       modula-relay setup <claude|codex> [--name <peer-name>]

Starts a Modula Relay MCP peer over stdio. Peers started in the same directory
share one pool and discover each other automatically. \`setup\` installs the
always-armed pieces (loop instructions, hooks, tool trust) for one harness.`

export function cliConfig(argv: string[], cwd = process.cwd(), env = process.env) {
  const flags = parseFlags(argv)
  const name = flags.get('name')
  if (!name) throw new Error(`--name is required\n\n${USAGE}`)
  const worktree = cwd
  return {
    name,
    worktree,
    project: flags.get('project') ?? derivedProject(worktree),
    relayDir: flags.get('dir') ?? env.MODULA_RELAY_DIR ?? defaultRelayDir(),
    purpose: flags.get('purpose') ?? '',
    model: flags.get('model') ?? 'unknown',
    // Wake ON by default for a standalone peer, so the shipped Stop hook / watcher can see
    // its queue depth and the always-armed loop works out of the box. When an embedded host
    // sets MODULA_RELAY_WAKE_ROLES (its explicit rollout allowlist), honor that list exactly
    // — gating on the immutable logical role, which a launcher may rename the registry entry from.
    ...(env.MODULA_RELAY_WAKE_ROLES ? (wakeEnabledForRole(env.MODULA_RELAY_ROLE || name, env) ? { wake: {} } : {}) : { wake: {} }),
  }
}

// The folder name alone is neither safe (spaces, dots) nor unique (/a/app and /b/app must
// not share a pool in the shared default dir); a sanitized slug plus a path digest is both.
function derivedProject(worktree: string) {
  const slug = path.basename(worktree).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[-_]+/, '').slice(0, 40) || 'pool'
  return `${slug}-${createHash('sha256').update(path.resolve(worktree)).digest('hex').slice(0, 8)}`
}

const KNOWN_FLAGS = new Set(['name', 'project', 'dir', 'purpose', 'model'])

function parseFlags(argv: string[]) {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') throw new Error(USAGE)
    if (!token.startsWith('--') || !KNOWN_FLAGS.has(token.slice(2))) throw new Error(`unknown argument "${token}"\n\n${USAGE}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value\n\n${USAGE}`)
    flags.set(token.slice(2), value)
    index += 1
  }
  return flags
}

// The default must be identical for every peer in a folder no matter which harness
// launched it. Harnesses sanitize MCP server env differently (one strips XDG_RUNTIME_DIR,
// another passes it), so an env-derived default silently splits one folder's peers into
// two pools. The home path is the one location every launcher agrees on.
function defaultRelayDir() {
  return path.join(stableHomeDir(), '.modula-relay', 'run')
}

// The passwd entry outlives any env sanitization a harness applies to HOME; env is only
// the fallback where no account database exists (some containers).
function stableHomeDir() {
  try { return os.userInfo().homedir } catch { return os.homedir() }
}

export async function runCli(argv = process.argv.slice(2)) {
  // stdout carries the MCP protocol; everything human goes to stderr.
  configureRelayHost({ logger: { warn: message => console.error(`modula-relay: ${message}`) } })
  if (argv[0] === 'setup') {
    const { runSetup } = await import('./setup.js')
    console.error(runSetup(argv.slice(1)))
    return
  }
  const config = cliConfig(argv)
  console.error(`modula-relay (contract ${RELAY_MCP_CONTRACT_VERSION}) · by ModulaStack · modulastack.com`)
  console.error(`peer "${config.name}" joining pool "${config.project}"`)
  await startRelayServer(new RelayAdapter(config))
}

// npm bin symlinks make argv[1] end in .bin/modula-relay, so the main-module check must
// resolve through the link to this file rather than pattern-match the invoked name.
function invokedAsMain() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
}

if (invokedAsMain()) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
