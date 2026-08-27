// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { relayHost } from './host.js'

export const TURN_PROTOCOL_VERSION = 1
export const TURN_PROTOCOL_ENV = 'MODULA_RELAY_TURN_PROTOCOL_ROLES'

export type TurnOrigin = 'operator' | 'relay' | 'system'
export type TurnEnvelope = { kind: 'agent-turn'; version: number; turnId: string; origin: TurnOrigin; message: string; instructingMessageRef?: string; sender?: string; senderVerified?: boolean }
export type TurnReply = { kind: 'turn-reply'; turnId: string; message: string }
export type TurnReceipt = { kind: 'turn-receipt'; turnId: string; ruling: string; instructingMessageRef: string; targetRefs: string[] }
export type TurnEnd = { kind: 'turn-end'; turnId: string }
export type TurnDispatch = { kind: 'turn-dispatch'; turnId: string; recipients: string[]; message: string }
export type TurnOutput = TurnReply | TurnReceipt | TurnEnd | TurnDispatch

export function issueTurnId() {
  return `turn-${randomUUID()}`
}

export function turnEnvelope(value: Omit<TurnEnvelope, 'kind' | 'version'>): string {
  return JSON.stringify({ kind: 'agent-turn', version: TURN_PROTOCOL_VERSION, ...value })
}

export function parseTurnOutput(line: string): TurnOutput | undefined {
  let value: Record<string, unknown>
  try { value = JSON.parse(line) as Record<string, unknown> } catch { return undefined }
  if (value.kind === 'turn-reply' && text(value.turnId) && text(value.message)) return { kind: 'turn-reply', turnId: value.turnId, message: value.message }
  if (value.kind === 'turn-receipt' && text(value.turnId) && text(value.ruling) && text(value.instructingMessageRef) && textArray(value.targetRefs)) return { kind: 'turn-receipt', turnId: value.turnId, ruling: value.ruling, instructingMessageRef: value.instructingMessageRef, targetRefs: value.targetRefs }
  if (value.kind === 'turn-end' && text(value.turnId)) return { kind: 'turn-end', turnId: value.turnId }
  if (value.kind === 'turn-dispatch' && text(value.turnId) && textArray(value.recipients) && text(value.message)) return { kind: 'turn-dispatch', turnId: value.turnId, recipients: value.recipients, message: value.message }
  return undefined
}

// Role-gated rollout: the protocol is a launch decision, not a code fork. An empty or
// absent variable means legacy behavior everywhere (a launch decision, not a code fork).
export function turnProtocolEnabled(role: string, env: NodeJS.ProcessEnv = process.env) {
  const roles = (env[TURN_PROTOCOL_ENV] ?? '').split(',').map(part => part.trim()).filter(Boolean)
  return roles.includes(role)
}

// Session credential primitives: possession-based payload provenance inside the
// per-user boundary. The secret never travels in a payload; only the tag does.
export function mintSessionCredential() {
  return randomBytes(32).toString('hex')
}

// Credential authority: per-session credentials derive from one key, so verification
// never needs a mint-time registry. The key is its own random secret — never derived
// from authToken, which is served to web clients and inherited by page-bot child envs,
// so deriving from it would let any token holder mint any session's credential.
let sessionCredentialKey: Buffer | undefined

export function setSessionCredentialKey(secret: string) {
  sessionCredentialKey = createHmac('sha256', secret).update('modula-relay-session-credential-v1').digest()
}

// Persisted under the state dir so verification survives server restarts; a lost
// persistence degrades to honest unverified labels after the next restart, never a crash.
export function initSessionCredentialKey(stateDir: string) {
  const file = path.join(stateDir, 'session-credential.key')
  const existing = readKeyFile(file)
  if (existing) { sessionCredentialKey = existing; return }
  const minted = randomBytes(32)
  // link is the atomic no-clobber publish: the key file only ever appears fully
  // written, so a raced reader can never adopt a partial key. EEXIST = another
  // server won; prefer its key so the shared state dir converges.
  const temporary = path.join(stateDir, `session-credential.key.${process.pid}.tmp`)
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(temporary, `${minted.toString('hex')}\n`, { mode: 0o600 })
    linkSync(temporary, file)
  } catch {
    const raced = readKeyFile(file)
    if (raced) { sessionCredentialKey = raced; return }
    relayHost().logger.warn('session credential key could not be persisted; credential verification will not survive a restart')
  } finally {
    // Cleanup must never mask the fallback: an unremovable temp file is cosmetic.
    try { rmSync(temporary, { force: true }) }
    catch { relayHost().logger.warn('session credential temporary file could not be removed') }
  }
  sessionCredentialKey = minted
}

function readKeyFile(file: string) {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(value) ? Buffer.from(value, 'hex') : undefined
  } catch { return undefined }
}

export function clearSessionCredentialKey() {
  sessionCredentialKey = undefined
}

// The credential binds the session, the server-assigned launch role, AND the job scope:
// the registry and pool directories are pane-writable, but what the server launched —
// which role, for which job — is not. A re-registered adapter (other name, other pool)
// therefore never holds a matching secret.
export function sessionCredentialFor(sessionId: string, name: string, scopeId: string) {
  if (!sessionCredentialKey) return undefined
  return createHmac('sha256', sessionCredentialKey).update(JSON.stringify([scopeId, sessionId, name])).digest('hex')
}

export function sessionCredentialEnv(sessionId: string, name: string, scopeId: string): Record<string, string> {
  const credential = sessionCredentialFor(sessionId, name, scopeId)
  return credential ? { MODULA_RELAY_SESSION_CREDENTIAL: credential } : {}
}

// One canonical byte form shared by signer and verifier: the tag binds the message id,
// the sender identity fields, the intended recipient, and the content. The recipient
// binding is what keeps a signed envelope from being laundered to a different peer —
// receivers expose signed fields to their own (inducible) models via relay_await.
export function credentialPayload(msgId: string, senderSession: string, senderName: string, recipientSession: string, prompt: string) {
  return JSON.stringify([msgId, senderSession, senderName, recipientSession, prompt])
}

export function signPayload(credential: string, payload: string) {
  return createHmac('sha256', credential).update(payload).digest('hex')
}

export function verifyPayload(credential: string, payload: string, tag: string) {
  const expected = Buffer.from(signPayload(credential, payload), 'hex')
  let presented: Buffer
  try { presented = Buffer.from(tag, 'hex') } catch { return false }
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function text(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }
function textArray(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(text) }
