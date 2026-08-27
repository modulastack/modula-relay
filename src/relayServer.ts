// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { RelayAdapter } from './relayAdapter.js'
import { relayHost } from './host.js'
import { RELAY_CONTEXT_USAGE_METHOD, RELAY_MCP_CONTRACT_VERSION, RELAY_MCP_SERVER_NAME, RELAY_WAKE_ACK_METHOD, RELAY_WAKE_NOTIFICATION_METHOD, RELAY_WAKE_STATE_METHOD } from './relayContract.js'
import { isSafePathSegment } from './relayEndpoint.js'

const timeout = z.number().int().positive().max(30_000).optional()
const correlationId = z.string().min(1).max(128)
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> })

export async function startRelayServer(adapter = RelayAdapter.fromEnv()) {
  await adapter.start()
  const server = new McpServer({ name: RELAY_MCP_SERVER_NAME, version: RELAY_MCP_CONTRACT_VERSION })
  tools(server, adapter)
  wakeChannel(server, adapter)
  contextUsageChannel(server, adapter)
  try { await server.connect(new StdioServerTransport()) }
  catch (error) { await adapter.close(); throw error }
  // Shutdown paths run from signal/stdin handlers with nothing awaiting them: a rejection
  // here would be unhandled, so failures surface through the host logger instead — and each
  // half closes independently, so a failed adapter teardown cannot leave the MCP server alive.
  const closeHalf = async (label: string, run: () => Promise<unknown>) => {
    try { await run() }
    catch (error) { relayHost().logger.warn(`relay shutdown failed (${label}): ${error instanceof Error ? error.message : String(error)}`) }
  }
  const close = async () => {
    await closeHalf('adapter', () => adapter.close())
    await closeHalf('server', () => server.close())
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  process.stdin.once('close', () => { void close() })
}

function tools(server: McpServer, adapter: RelayAdapter) {
  const shapes = {
    roster: { project: z.string().min(1).optional(), include_explicit: z.boolean().optional() },
    // Half the 64KB transport line cap in characters: JSON escaping can inflate the wire
    // bytes, and the envelope carries metadata beside the prompt. Oversize is refused here
    // with a usable error instead of dying at the transport as a destroyed connection.
    dispatch: { target: z.string().min(1), prompt: z.string().min(1).max(32_768), conversation_id: z.string().optional(), response_schema: z.record(z.unknown()).optional() },
    poll: { msg_id: correlationId },
    await: { msg_id: correlationId.optional(), timeout_ms: timeout },
    reply: { msg_id: correlationId, response: z.unknown() },
    cancel: { msg_id: correlationId.optional(), target: z.string().min(1).optional() },
  }
  const roster = async (input: { project?: string; include_explicit?: boolean }) => text({ project: adapter.project, agents: await adapter.list(input.project, input.include_explicit) })
  const dispatch = (input: { target: string; prompt: string; conversation_id?: string; response_schema?: Record<string, unknown> }) => {
    const attempt = adapter.send(input.target, input.prompt, input.conversation_id, input.response_schema)
    const receipt = { ...attempt.receipt }
    void attempt.catch(() => undefined)
    return text(receipt.state === 'undeliverable' ? { receipt } : { msg_id: receipt.msgId, receipt })
  }
  const poll = (input: { msg_id: string }, extra: { signal: AbortSignal }) => text(adapter.get(input.msg_id, extra.signal))
  const awaited = (input: { msg_id?: string; timeout_ms?: number }, extra: { signal: AbortSignal }) => wait(adapter, input.msg_id, input.timeout_ms, extra.signal)
  const reply = async (input: { msg_id: string; response?: unknown }) => { await adapter.respond(input.msg_id, input.response); return text({ status: 'complete', note: 'Reply delivered. Resume relay_await now to stay reachable for the next message.' }) }
  const cancel = (input: { msg_id?: string; target?: string }) => text({ cancelled: adapter.cancel({ msgId: input.msg_id, target: input.target }) })

  const ROSTER = 'List live same-worktree peers in this pool.'
  const DISPATCH = 'Dispatch one bounded request to a peer name or same-pool session id.'
  const POLL = 'Poll an outbound reply without blocking.'
  const AWAIT = 'Await an inbound request or an outbound reply for at most 30 seconds. Without msg_id it returns whichever arrives first: an inbound "request" to answer, or a completed "reply" to a request you dispatched earlier (so staying in the await loop is enough to receive answers). A timeout reports "peers": the number of other agents registered in this pool. peers=0 on a first timeout can mean registration is still in progress, so await once more; peers=0 on a second consecutive timeout means nobody registered — report the empty pool instead of looping.'
  const REPLY = 'Answer one inbound request.'
  // Annotations are honest hints for harness permission engines: every tool operates
  // only on the local same-user pool (no network — openWorldHint false), and none is
  // read-only — roster prunes dead registry entries, poll/await consume delivery state.
  // Roster, reply and cancel carry destructiveHint (deleted entries, an inbound request
  // consumed for good, discarded in-flight requests). They inform auto-approval; they
  // never demand it.
  const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  server.registerTool('relay_roster', { description: ROSTER, inputSchema: shapes.roster, annotations: destructive }, roster)
  server.registerTool('relay_dispatch', { description: DISPATCH, inputSchema: shapes.dispatch, annotations: additive }, dispatch)
  server.registerTool('relay_poll', { description: POLL, inputSchema: shapes.poll, annotations: additive }, poll)
  server.registerTool('relay_await', { description: AWAIT, inputSchema: shapes.await, annotations: additive }, awaited)
  server.registerTool('relay_reply', { description: REPLY, inputSchema: shapes.reply, annotations: destructive }, reply)
  server.registerTool('relay_cancel', { description: 'Cancel in-flight outbound request(s) and free their send slots: by msg_id, by target peer name or session id, or every pending outbound when called with no arguments.', inputSchema: shapes.cancel, annotations: destructive }, cancel)
}

function wait(adapter: RelayAdapter, msgId: string | undefined, timeoutMs: number | undefined, signal?: AbortSignal) {
  // Keyed cancellation recovery lives in the adapter (armed only on unread→read).
  const waited = msgId
    ? adapter.awaitReply(msgId, timeoutMs ?? 30_000, signal)
    : adapter.awaitInbound(timeoutMs ?? 30_000, signal).then(result => redactInbound(classifySeen(adapter, result, signal)))
  return waited.then(text)
}

// Seen means returned to a live, uncancelled caller: the abort signal at return time is
// the only observation point (the SDK suppresses results after cancellation, so the
// agent never saw a hand-off the abort raced). The hand generation makes the reclaim
// race-proof — a stale cancelled await cannot mark a message a newer await has seen as
// unseen — and never reaches the agent: it is stripped from every tool result here.
function classifySeen<T extends { status: string; request?: { msgId: string }; handSeq?: number }>(adapter: RelayAdapter, result: T, signal?: AbortSignal): T {
  // Reply hand-offs need no handling here: the adapter arms cancellation reclaim at read
  // time (fenced per handoff) and never surfaces a reply into an already-aborted await.
  if (!signal || !result.request || result.handSeq === undefined) return stripHandSeq(result)
  const reclaim = () => adapter.reclaimInbound(result.request!.msgId, result.handSeq!)
  if (!signal.aborted) {
    // The snapshot alone leaves a check-to-publication race: a cancellation landing
    // after this point still discards the result client-side, so the retained
    // listener reclaims it. The hand generation makes a late fire harmless — a newer
    // hand-off owns the message and the stale reclaim is a no-op.
    signal.addEventListener('abort', reclaim, { once: true })
    return stripHandSeq(result)
  }
  reclaim()
  const reclaimed = { ...result, status: 'timeout' }
  delete reclaimed.request
  return stripHandSeq(reclaimed)
}

function stripHandSeq<T extends { handSeq?: number }>(result: T): T {
  if (result.handSeq === undefined) return result
  const stripped = { ...result }
  delete stripped.handSeq
  return stripped
}

// Bridge-private wake channel: never registered as tools, so the bridge's literal
// tool-inventory parity check is unaffected and no model ever sees a lease surface.
function wakeChannel(server: McpServer, adapter: RelayAdapter) {
  adapter.onWake(event => {
    void server.server.notification({ method: RELAY_WAKE_NOTIFICATION_METHOD, params: { episode_id: event.episodeId, undelivered: event.undelivered, attempt: event.attempt } })
      .catch(() => relayHost().logger.warn('relay wake notification send failed; delivery unaffected'))
  })
  server.server.setRequestHandler(z.object({ method: z.literal(RELAY_WAKE_STATE_METHOD), params: z.object({}).passthrough().optional() }), () => wakeState(adapter))
  server.server.setRequestHandler(
    z.object({ method: z.literal(RELAY_WAKE_ACK_METHOD), params: z.object({ episode_id: z.string().min(1), state: z.enum(['armed', 'held', 'emitted', 'retrying', 'exhausted', 'dropped']) }) }),
    request => ({ lease_until: adapter.ackWake(request.params.episode_id, request.params.state) ?? null }),
  )
}

function wakeState(adapter: RelayAdapter) {
  const snapshot = adapter.wakeSnapshot()
  if (!snapshot) return { enabled: false }
  return { enabled: true, undelivered: snapshot.undelivered, episode_id: snapshot.episodeId ?? null, tier1: snapshot.tier1 ?? null }
}

function contextUsageChannel(server: McpServer, adapter: RelayAdapter) {
  server.server.setRequestHandler(z.object({ method: z.literal(RELAY_CONTEXT_USAGE_METHOD), params: z.object({ context_used_pct: z.number().finite().min(0).max(100).optional() }).passthrough().optional() }), request => {
    adapter.updateContextUsage(request.params?.context_used_pct)
    return { published: request.params?.context_used_pct !== undefined }
  })
}

// The tag is transport provenance, not model input: keeping it out of tool results means
// no model can be induced to quote one, even though recipient binding already makes a
// quoted tag worthless anywhere else.
export function redactInbound<T extends { request?: { credentialTag?: string } }>(result: T): T {
  if (!result.request?.credentialTag) return result
  const request = { ...result.request }
  delete request.credentialTag
  return { ...result, request }
}

export async function recordStartupFailure(error: unknown, env = process.env) {
  const directory = env.MODULA_RELAY_DIR, sessionId = env.MODULA_RELAY_SESSION_ID
  if (!directory || !sessionId || !isSafePathSegment(sessionId)) return
  const file = path.join(directory, 'bridge-failures', `${sessionId}.json`)
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify({ reason: error instanceof Error ? error.message : String(error), exitCode: 1, signal: null }), { mode: 0o600 })
  } catch {}
}
