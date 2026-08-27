// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

export type RegistryEntry = {
  session_id: string; name: string; purpose: string; model: string; color: string
  pid: number; endpoint: string; cwd: string; started_at: string; explicit: boolean; version: number
  context_used_pct?: number; context_reported_at?: string; queue_depth?: number; heartbeat_at?: string; heartbeat_ms?: number; implementation?: string; last_await_at?: string
  // Wake fields, present only when the recipient's wake gate is on. Candidate
  // signal for the tier-2 watcher; never authorization (the registry is pane-writable).
  undelivered_depth?: number; undelivered_episode_id?: string; wake_tier1?: { state: string; leaseUntil: number }
}
export type Prompt = { type: 'prompt'; msg_id: string; sender_session: string; sender_endpoint: string; sender_name: string; sender_cwd: string; hops: number; timestamp: string; prompt: string; conversation_id?: string | null; response_schema?: object | null; credential_tag?: string | null }
export type Response = { type: 'response'; msg_id: string; sender_session: string; sender_endpoint: string; hops: number; timestamp: string; response: unknown; error?: string | null }
export type Ping = { type: 'ping'; msg_id: string; sender_session: string; sender_endpoint: string; hops: number; timestamp: string }
export type Envelope = Prompt | Response | Ping
export type TransportReply = { type: 'ack' | 'nack' | 'pong'; msg_id: string; error?: string }
type RegistryRecord = { entry: RegistryEntry; file: string }

export function parseEnvelope(line: string) {
  const value = JSON.parse(line) as Record<string, unknown>
  if (!commonEnvelope(value)) throw new Error('malformed envelope')
  // sender_name is reproduced in labels delivered into a child's prompt and into dock
  // history; every real adapter registers a safe segment, so anything else is forged.
  if (value.type === 'prompt' && segment(value.sender_name) && string(value.sender_cwd) && integer(value.hops) && string(value.timestamp) && string(value.prompt) && optionalString(value.conversation_id) && optionalObject(value.response_schema) && optionalString(value.credential_tag)) return value as Prompt
  if (value.type === 'response' && integer(value.hops) && string(value.timestamp) && Object.hasOwn(value, 'response') && optionalString(value.error)) return value as Response
  if (value.type === 'ping' && integer(value.hops) && string(value.timestamp)) return value as Ping
  throw new Error('malformed envelope')
}

export function parseTransportReply(line: string) {
  const value = JSON.parse(line) as Record<string, unknown>
  if (!string(value.type) || !string(value.msg_id) || !['ack', 'nack', 'pong'].includes(value.type) || !optionalString(value.error) || (value.type === 'pong' && !object(value.agent_card))) throw new Error('malformed acknowledgement')
  return value as TransportReply
}

export function pruneDeadEntries(directory: string, endpointFor?: (sessionId: string) => string): RegistryEntry[] {
  const records = readEntries(directory)
  const live = records.filter(({ entry }) => processAlive(entry.pid))
  for (const { entry, file } of records) {
    if (live.some(record => record.entry === entry)) continue
    rmSync(file, { force: true })
    reapEndpoint(entry, live, endpointFor)
  }
  return live.map(({ entry }) => entry)
}

// A crashed peer leaves its socket file behind — the pruned entry is the only thing that
// names it. The endpoint field is pane-writable and therefore untrusted: only the canonical
// endpoint for that session may be removed, only while no live entry still claims it, only
// when the object there is actually a socket, and only when it was bound while the dead
// peer was alive — a socket newer than the peer's last sign of life belongs to a successor
// that has not registered yet, and deleting it would strand a live agent.
function reapEndpoint(entry: RegistryEntry, live: RegistryRecord[], endpointFor?: (sessionId: string) => string) {
  if (!endpointFor || entry.endpoint !== endpointFor(entry.session_id)) return
  if (live.some(record => record.entry.endpoint === entry.endpoint)) return
  try {
    const bound = lstatSync(entry.endpoint)
    if (!bound.isSocket()) return
    const lastAlive = Date.parse(entry.heartbeat_at ?? entry.started_at)
    if (!Number.isFinite(lastAlive) || bound.mtimeMs > lastAlive) return
    // The judged corpse may be replaced by a live successor while we decide: remove only
    // the exact object the verdict was about (same guard clearStaleEndpoint uses).
    const recheck = lstatSync(entry.endpoint)
    if (recheck.dev !== bound.dev || recheck.ino !== bound.ino) return
    rmSync(entry.endpoint, { force: true })
  } catch {}
}

function readEntries(directory: string) { return !existsSync(directory) ? [] : readdirSync(directory).filter(file => file.endsWith('.json')).flatMap(file => readEntry(path.join(directory, file))) }
function readEntry(file: string): RegistryRecord[] {
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as RegistryEntry
    return validRegistryEntry(entry, file) ? [{ entry, file }] : []
  } catch { return [] }
}
export function validRegistryEntry(entry: RegistryEntry, file: string) {
  return segment(entry.session_id) && segment(entry.name) && path.basename(file) === `${entry.name}.json` && text(entry.purpose) && text(entry.model) && text(entry.color) && integer(entry.pid) && string(entry.endpoint) && path.isAbsolute(entry.endpoint) && string(entry.cwd) && path.isAbsolute(entry.cwd) && text(entry.started_at) && typeof entry.explicit === 'boolean' && integer(entry.version)
}
function commonEnvelope(value: Record<string, unknown>) { return string(value.type) && ['prompt', 'response', 'ping'].includes(value.type) && string(value.msg_id) && segment(value.sender_session) && string(value.sender_endpoint) }
function string(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function text(value: unknown): value is string { return typeof value === 'string' }
function integer(value: unknown) { return typeof value === 'number' && Number.isInteger(value) && value >= 0 }
function optionalString(value: unknown) { return value === undefined || value === null || typeof value === 'string' }
function optionalObject(value: unknown) { return value === undefined || value === null || object(value) }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function segment(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) }
export function processAlive(pid: number) { try { process.kill(pid, 0); return true } catch (error: any) { return error?.code === 'EPERM' } }
