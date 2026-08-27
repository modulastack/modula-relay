// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'

const MAX_UNIX_SOCKET_PATH = 100
const SOCKET_PREFIX = '/tmp/modula-relay-'

export const RELAY_RUNTIME_DIR_ENV = 'MODULA_RELAY_RUNTIME_DIR'
export const RELAY_RUNTIME_DIR_REQUIRED_ENV = 'MODULA_RELAY_RUNTIME_DIR_REQUIRED'

export function relayEndpoint(relayDir: string, sessionId: string, platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\modula-relay-${sessionId}`
  const direct = path.join(relayDir, 'sockets', `${sessionId}.sock`)
  return Buffer.byteLength(direct) <= MAX_UNIX_SOCKET_PATH ? direct : path.join(relayRuntimeDirectory(), endpointDigest(relayDir, sessionId))
}

export function relaySocketDirectory(relayDir: string, sessionId: string, platform = process.platform) {
  return path.dirname(relayEndpoint(relayDir, sessionId, platform))
}

// The shared per-uid directory is the default, not the law: every agent on the host lands
// in it, so a process that must not touch other lanes' endpoints (a test run, a sandbox)
// relocates itself here instead of operating on the live one .
export function relayRuntimeDirectory(uid = process.getuid?.(), env = process.env) {
  const override = env[RELAY_RUNTIME_DIR_ENV]
  if (override) {
    // MODULA_RELAY_RUNTIME_DIR is trusted input: only the test harness or an operator sets it,
    // and setting it already implies control of the process environment. Ancestor trust is
    // validated only to the immediate parent (assertTrustedParent's owner + sticky check); full
    // descriptor-relative traversal is deferred  because the shipped default's only
    // ancestors are / and /tmp (1777, sticky). It becomes required if operator-chosen dirs
    // outside /tmp become a supported configuration.
    if (!path.isAbsolute(override)) throw new Error(`${RELAY_RUNTIME_DIR_ENV} must be an absolute path`)
    const resolved = path.resolve(override)
    // This directory exists to hold the endpoints long pool paths fall back to, so one too
    // long to hold a digest filename fails every bind instead of the one it was meant to fix.
    if (Buffer.byteLength(path.join(resolved, `${'0'.repeat(64)}.sock`)) > MAX_UNIX_SOCKET_PATH) throw new Error(`${RELAY_RUNTIME_DIR_ENV} is too long for Unix socket endpoints`)
    return resolved
  }
  if (env[RELAY_RUNTIME_DIR_REQUIRED_ENV]) throw new Error(`relay runtime directory must be set via ${RELAY_RUNTIME_DIR_ENV}`)
  if (!Number.isInteger(uid) || uid! < 0) throw new Error('relay runtime directory requires a numeric user id')
  return `${SOCKET_PREFIX}${uid}`
}

export function ensureRelayRuntimeDirectory() {
  const directory = relayRuntimeDirectory()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return assertPrivateDirectory(directory)
}

// Tightening a group-writable directory would preserve entries planted before the repair.
// Launchers now use this private per-uid path by default, leaving the legacy loose base behind.
function assertPrivateDirectory(directory: string) {
  assertTrustedParent(directory)
  const fd = openDirectory(directory)
  try {
    const stats = fstatSync(fd)
    if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o700) throw insecure()
    return directory
  } finally { closeSync(fd) }
}

// A directory is only as private as the one holding it: where others may write, they may also
// replace it between validation and use. The sticky bit forbids exactly that, which is why the
// default lives under /tmp (1777); a relocation onto a writable non-sticky parent would not.
function assertTrustedParent(directory: string) {
  const parent = path.dirname(directory)
  if (parent === directory) return
  const stats = lstatSync(parent)
  // A foreign owner can replace what sits inside its own directory whatever the mode bits say.
  const trustedOwner = stats.uid === process.getuid?.() || stats.uid === 0
  if (!trustedOwner) throw new Error('relay runtime directory is insecure: foreign parent')
  if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) throw new Error('relay runtime directory is insecure: writable parent')
}

function openDirectory(directory: string) {
  try { return openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
  catch (error: any) {
    // Only a symlink (ELOOP under O_NOFOLLOW) or a non-directory is a trust failure;
    // anything else is an ordinary IO fault and must keep its own diagnosis.
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') throw insecure()
    throw error
  }
}

function insecure() { return new Error('relay runtime directory is insecure') }

export function ensureRelaySocketDirectory(endpoint: string) {
  if (path.dirname(endpoint) === relayRuntimeDirectory()) ensureRelayRuntimeDirectory()
}

export function isSafePathSegment(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..'
}

function endpointDigest(relayDir: string, sessionId: string) {
  return `${createHash('sha256').update(path.resolve(relayDir)).update('\0').update(sessionId).digest('hex')}.sock`
}
