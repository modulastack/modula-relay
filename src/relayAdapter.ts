// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { relayHost } from './host.js'
import { currentContextUsage } from './contextUsage.js'
import { relayEndpoint, relaySocketDirectory, ensureRelaySocketDirectory } from './relayEndpoint.js'
import { connect, EndpointUnreachableError, lineCap, readLine, withTimeout } from './relayTransport.js'
import { parseEnvelope, parseTransportReply, processAlive, pruneDeadEntries, validRegistryEntry, type Envelope, type Ping, type Prompt, type RegistryEntry, type Response } from './relayWire.js'
import { WakeTracker, type Tier1WakeState, type WakeEvent, type WakeSnapshot } from './relayWakeTracker.js'
import { credentialPayload, signPayload } from './agentTurnProtocol.js'
import { RELAY_MCP_CONTRACT_VERSION, RELAY_MCP_SERVER_NAME } from './relayContract.js'

const maxHops = 5
const maxInbound = 32
// One misbehaving sender must not occupy the whole inbound queue and starve the pool.
const senderQuota = 4
const maxRetainedResults = 256
const outboundExpiryMs = 60 * 60_000
type Reply = { response?: unknown; error?: string }
type PromptOptions = { prompt: string; hops: number; conversationId?: string; responseSchema?: object }
type Pending = { result?: Reply; resolve: (reply: Reply) => void; promise: Promise<Reply>; sessionId: string; endpoint: string; peerName: string; expiry?: NodeJS.Timeout }
type ReplyResult = { status: 'complete' | 'pending' | 'timeout' | 'error'; response?: unknown; error?: string; peers?: number }
export type DeliveryReceipt = { state: 'undeliverable' | 'pending' | 'delivered'; target: string; msgId?: string; error?: string; note?: string }
export type DeliveryAttempt = Promise<string> & { readonly receipt: DeliveryReceipt }
// handSeq is the hand-off generation: only the caller holding the latest one may
// reclaim, so a stale cancelled await can never mark a message a newer await has
// already seen as unseen. Never agent-visible (the relay server strips it from tool results).
type InboundResult = { status: 'complete' | 'timeout'; request?: InboundRequest; reply?: SurfacedReply; handSeq?: number; peers?: number }
export type SurfacedReply = { msg_id: string; response?: unknown; error?: string }
export type InboundRequest = { msgId: string; senderName: string; senderSession: string; senderCwd: string; prompt: string; conversationId?: string | null; responseSchema?: object | null; credentialTag?: string }
export type WakeConfig = { graceMs?: number; attemptCap?: number; budgetPerHour?: number; leaseMs?: number; clock?: () => number }
export type RelayAdapterConfig = { relayDir: string; project: string; worktree: string; name: string; purpose: string; model: string; sessionId?: string; color?: string; inboundLimit?: number; outboundExpiryMs?: number; heartbeatMs?: number; credential?: string; wake?: WakeConfig }

const heartbeatMs = 30_000

export const RELAY_WAKE_ROLES_ENV = 'MODULA_RELAY_WAKE_ROLES'

// Recipient-role gate for the wake layer: absent/empty means every wake surface
// (hook, registry fields, notification) is off and behavior is byte-identical (a rollout choice
//).
export function wakeEnabledForRole(role: string, env: NodeJS.ProcessEnv = process.env) {
  return (env[RELAY_WAKE_ROLES_ENV] ?? '').split(',').map(part => part.trim()).filter(Boolean).includes(role)
}

export class RelayAdapter {
  private readonly config: RelayAdapterConfig
  private readonly sessionId: string
  private readonly endpoint: string
  private readonly pending = new Map<string, Pending>()
  private readonly inbound = new Map<string, Prompt>()
  private readonly queue: InboundRequest[] = []
  private inboundWaiter?: (request: InboundRequest | undefined) => void
  private awaitingInbound = false
  private server?: net.Server
  private heartbeat?: NodeJS.Timeout
  private readonly sockets = new Set<net.Socket>()
  private readonly outbound = new Map<string, string>()
  // msg_ids currently handed to an awaiter (active or resolved-but-not-yet-active). The
  // self-heal must not re-queue these, or a concurrent awaitInbound double-delivers them.
  private readonly delivering = new Set<string>()
  // FIFO of completed outbound msg_ids, bounded so an unpolled reply stream to one
  // recipient cannot retain results without limit for the full expiry window. `observed`
  // marks results a caller has already read, so eviction drops those before unread ones.
  private readonly completed: string[] = []
  private readonly observed = new Set<string>()
  private activeInbound?: Prompt
  private resolvedName = ''
  private registryFile = ''
  private ownershipLossHandler?: () => void
  private readonly wake?: WakeTracker
  private wakeHandler?: (event: WakeEvent) => void
  private activeUnseen = false
  private unrefed = false
  private started = false
  private closed = false
  private socketIdentity?: string
  private rebinding?: Promise<void>
  private ownershipSurrendered = false
  private ownershipLossDetected = false
  private ownershipLossDelivered = false
  private handSeq = 0
  private contextUsedPct?: number
  private contextReportedAt?: string
  private lastAwaitAt?: string
  private readonly replyReads = new Map<string, number>()
  private readonly reclaimListeners = new Map<string, Map<() => void, AbortSignal>>()

  constructor(config: RelayAdapterConfig, runtimeCwd = process.cwd()) {
    this.config = validateConfig(config, runtimeCwd)
    this.sessionId = this.config.sessionId ?? randomUUID().replaceAll('-', '')
    this.endpoint = relayEndpoint(this.config.relayDir, this.sessionId)
    // The handler is late-bound (the MCP server that forwards wake notifications is
    // constructed after the adapter) and failure-isolated on every path, including
    // timer re-fires that run outside any caller's try/catch.
    if (config.wake) this.wake = new WakeTracker({ ...config.wake, onWake: event => { try { this.wakeHandler?.(event) } catch { relayHost().logger.warn('relay wake notification failed; delivery unaffected') } } })
  }

  onWake(handler: (event: WakeEvent) => void) {
    this.wakeHandler = handler
  }

  get project() { return this.config.project }
  get name() { return this.resolvedName }
  get session() { return this.sessionId }

  // Registry-derived identity for an inbound sender: sender_name on the wire is
  // self-declared, so display trust must come from the entry bound to the session.
  peerName(sessionId: string) {
    return this.entries().find(entry => entry.session_id === sessionId)?.name
  }

  updateModel(model: string) {
    if (this.config.model === model) return
    this.config.model = model
    // Only while serving: registryFile survives close(), and a write after deregistration
    // would resurrect the entry as a ghost peer with no listening socket.
    if (this.registryFile && this.server && !this.writeRegistry()) this.notifyOwnershipLoss()
  }

  updateContextUsage(percent: unknown) {
    const next = validContextUsage(percent) ? percent : undefined
    if (next === undefined && this.contextUsedPct === undefined) return
    this.contextUsedPct = next
    this.contextReportedAt = next === undefined ? undefined : now()
    if (this.registryFile && this.server && !this.writeRegistry()) this.notifyOwnershipLoss()
  }

  // Published so senders can tell a listening peer from an idle one: dispatch to a peer
  // that never awaits queues invisibly forever — the silent black hole of every stale
  // -session debugging story. Memory-only on purpose: the heartbeat publishes it on its
  // own cadence, so the await read path never runs registry-write ownership machinery
  // (a write here resurrects crash-simulated entries and fires spurious ownership loss).
  private recordAwait() {
    this.lastAwaitAt = now()
  }

  // Post-start ownership loss must reach the host: an embedded standing peer that keeps
  // serving after its registry entry was claimed would answer traffic it no longer owns.
  onOwnershipLoss(handler: () => void) {
    this.ownershipLossHandler = handler
    this.deliverOwnershipLoss()
  }

  // Detection and host delivery are separate because embedded hosts register their handler
  // after adapter startup. A terminal loss detected in that gap must still be delivered once.
  private notifyOwnershipLoss() {
    this.ownershipLossDetected = true
    this.deliverOwnershipLoss()
  }

  private deliverOwnershipLoss() {
    if (!this.ownershipLossDetected || this.ownershipLossDelivered || !this.ownershipLossHandler) return
    this.ownershipLossDelivered = true
    this.ownershipLossHandler()
  }

  static fromEnv(env = process.env) {
    return new RelayAdapter({
      relayDir: required(env.MODULA_RELAY_DIR, 'MODULA_RELAY_DIR'), project: required(env.MODULA_RELAY_PROJECT, 'MODULA_RELAY_PROJECT'),
      worktree: required(env.MODULA_RELAY_WORKTREE, 'MODULA_RELAY_WORKTREE'), name: required(env.MODULA_RELAY_NAME, 'MODULA_RELAY_NAME'),
      purpose: env.MODULA_RELAY_PURPOSE ?? '', model: env.MODULA_RELAY_MODEL_LABEL ?? 'unknown', sessionId: env.MODULA_RELAY_SESSION_ID, color: env.MODULA_RELAY_COLOR,
      inboundLimit: positiveInt(env.MODULA_RELAY_INBOUND_LIMIT), outboundExpiryMs: positiveInt(env.MODULA_RELAY_OUTBOUND_EXPIRY_MS), heartbeatMs: positiveInt(env.MODULA_RELAY_HEARTBEAT_MS),
      credential: env.MODULA_RELAY_SESSION_CREDENTIAL || undefined,
      // Gate on the immutable logical role: the registry name can be rewritten by the
      // launcher (lead → lead-agent) and must not decide wake eligibility.
      ...(wakeEnabledForRole(env.MODULA_RELAY_ROLE || env.MODULA_RELAY_NAME || '', env) ? { wake: {} } : {}),
    })
  }

  async start() {
    mkdirSync(this.agentsDir(), { recursive: true, mode: 0o700 })
    this.reserveName()
    try {
      await this.bind()
      // Losing the reservation between reserve and first write must fail the start: a
      // silent skip would report success while traffic resolves to another session.
      if (!this.writeRegistry()) throw new Error('relay: registry name lost during startup')
    } catch (error) {
      // Cleanup best-effort: a deregister failure must not mask the startup error.
      await this.close().catch(() => undefined)
      throw error
    }
    this.started = true
    this.heartbeat = setInterval(() => this.heartbeatTick(), this.config.heartbeatMs ?? heartbeatMs)
    this.heartbeat.unref()
  }

  // A host process embedding the adapter (the term server's standing Lead) must not have its
  // lifetime pinned by the relay socket; peers detect the host's exit via the registry pid.
  // The choice outlives any single server instance, so a rebind must reapply it.
  unref() {
    this.unrefed = true
    this.server?.unref()
  }

  // Binding happens once at spawn, so an endpoint deleted underneath a live owner used to
  // stay dead until the pane respawned . Reachability is ownership, not presence: a
  // plain file or a successor socket at the path  reads as "still bound" under a bare
  // existence check while the heartbeat advertises an endpoint that no longer reaches us. So
  // rebind whenever the object at the path is not the socket we bound. Callers with a lever
  // of their own (lead renewal) heal on demand; every other owner heals on its next heartbeat.
  async ensureBound() {
    if (this.closed || process.platform === 'win32' || !this.started || this.ownershipSurrendered) return
    if (this.boundSocketPresent()) return
    if (this.rebinding) return this.rebinding
    this.rebinding = this.rebind()
    try { await this.rebinding }
    finally { this.rebinding = undefined }
  }

  // Reachable only when the path holds the exact socket we bound. A cleared identity (a
  // prior rebind released the handle) or a different object at the path both need a rebind,
  // so a two-undefined match must never read as "still bound" and strand a broken-parent
  // retry  — the presence of our own inode is the signal, not mere path existence.
  private boundSocketPresent() {
    return this.socketIdentity !== undefined && this.currentSocketIdentity() === this.socketIdentity
  }

  private async rebind() {
    for (const socket of this.sockets) socket.destroy()
    await this.releaseServer()
    try {
      await this.bind()
    } catch (error) {
      // A live foreign owner of our path is a permanent ownership loss, not a transient
      // bind failure: clearStaleEndpoint's pid fence refuses to evict it, so retrying every
      // heartbeat can only log-storm. Surrender once and escalate. Every other failure (a
      // broken parent dir, EMFILE) stays retryable so an earlier later-heartbeat heal survives.
      if (error instanceof EndpointContendedError) return this.surrenderOwnership()
      throw error
    }
    relayHost().logger.warn(`relay endpoint ${this.endpoint} no longer resolved to our socket; rebound`)
  }

  private surrenderOwnership() {
    this.ownershipSurrendered = true
    // Stop the heartbeat and drop the owned entry: a surrendered adapter that kept
    // publishing would advertise a name against a foreign endpoint and leave a permanently
    // dead entry after that peer exits. The latch alone silences rebinds, not the registry.
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined }
    // Escalation must survive a failed deregistration: a throw here (a registry path replaced
    // by a directory) would otherwise strand the loss latched but un-escalated, serving dark.
    try { this.deregister() }
    finally {
      relayHost().logger.warn(`relay endpoint ${this.endpoint} is held by another live owner; surrendering ownership`)
      this.notifyOwnershipLoss()
    }
  }

  // Node unlinks by pathname on close and offers neither close-without-unlink nor
  // unlink-by-inode , so a listener whose path now holds a foreign object is abandoned,
  // never closed: closing would unlink whatever occupies the path, and a plain file we could
  // safely reclaim cannot be told apart from a live successor's socket atomically with close().
  // Healing the mismatch costs one descriptor — the safe choice over racing a successor's socket.
  private releaseServer() {
    const server = this.server
    this.server = undefined
    const current = this.currentSocketIdentity()
    const stolen = Boolean(current && this.socketIdentity && current !== this.socketIdentity)
    this.socketIdentity = undefined
    if (!server) return Promise.resolve()
    if (!stolen) return closeServer(server)
    server.unref()
    return Promise.resolve()
  }

  wakeSnapshot(): WakeSnapshot | undefined {
    return this.wake?.snapshot()
  }

  ackWake(episodeId: string, state: Tier1WakeState) {
    return this.wake?.ack(episodeId, state)
  }

  // A hand-off raced by await cancellation was never seen by the agent: the MCP layer
  // (which alone observes the request's abort signal at return time) reports it here.
  // Delivery state is deliberately untouched — the adapter already redelivers the
  // active inbound first on the next await, and queue surgery here could double-hand
  // a message a concurrent await just re-received. Only the undelivered count changes.
  reclaimInbound(msgId: string, handSeq: number) {
    if (this.activeInbound?.msg_id !== msgId || handSeq !== this.handSeq) return
    this.activeUnseen = true
    this.wakeUpdate()
  }

  private undeliveredCount() {
    return this.queue.length + (this.activeUnseen && this.activeInbound ? 1 : 0)
  }

  // Strictly failure-isolated (the async-event-handler rule at this seam): a wake
  // problem must never become a delivery problem, so the hook runs after the queue
  // mutation settles and any throw is only logged.
  private wakeUpdate() {
    if (!this.wake) return
    try { this.wake.update(this.undeliveredCount()) }
    catch { relayHost().logger.warn('relay wake hook failed; delivery unaffected') }
  }

  async close() {
    this.closed = true
    // A rebind settling after the teardown would resurrect the socket this close removes.
    await this.rebinding?.catch(() => undefined)
    this.wake?.close()
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const socket of this.sockets) socket.destroy()
    for (const pending of this.pending.values()) if (pending.expiry) clearTimeout(pending.expiry)
    // No unlink of our own: closing the listener already removes the socket it bound, and an
    // unlink after that await could only ever land on a successor that took the path since.
    await this.releaseServer()
    this.deregister()
  }

  // Only the owner may deregister: another session may have legitimately claimed the name
  // after a reclaim, so this must not delete its entry. Clearing registryFile makes the
  // removal idempotent — close after a surrender that already deregistered is a no-op.
  private deregister() {
    if (!this.registryFile) return
    if (this.ownsRegistryFile()) rmSync(this.registryFile, { force: true })
    this.registryFile = ''
  }

  // Ownership token for every registry write: the entry's session_id. A foreign live
  // entry means the name was lost — first valid writer wins, and the loser must not
  // flap the roster by overwriting; missing/invalid/dead-foreign content is claimable.
  private ownsRegistryFile() {
    try {
      const entry = JSON.parse(readFileSync(this.registryFile, 'utf8')) as RegistryEntry
      return entry.session_id === this.sessionId || !processAlive(entry.pid)
    } catch { return true }
  }

  async list(project?: string, includeExplicit = false) {
    if (project !== undefined && project !== this.config.project) throw new Error('relay: project outside configured pool')
    const entries = this.entries().filter(entry => entry.session_id !== this.sessionId && (includeExplicit || !entry.explicit))
    return Promise.all(entries.map(async entry => ({ ...publicEntry(entry, this.config.project), alive: await this.ping(entry) })))
  }

  send(target: string, prompt: string, conversationId?: string, responseSchema?: object): DeliveryAttempt {
    const hops = this.activeInbound ? this.activeInbound.hops + 1 : 0
    if (hops >= maxHops) return failedDelivery(target, new Error(`relay: hop limit reached (${hops} >= ${maxHops})`))
    let peer: RegistryEntry
    try { peer = this.target(target) }
    catch (error) { return failedDelivery(target, error) }
    // One in-flight request per recipient (L-6): a wedged peer must not lock the whole pool.
    if (this.outbound.has(peer.name)) return failedDelivery(target, new Error(`relay: outbound request to "${peer.name}" already in flight`))
    const msgId = randomUUID()
    const pending = deferred(peer.session_id, peer.endpoint, peer.name)
    const receipt: DeliveryReceipt = { state: 'pending', msgId, target: peer.name, ...idleTargetNote(peer) }
    this.outbound.set(peer.name, msgId)
    this.pending.set(msgId, pending)
    const delivery = this.sendEnvelope(peer.endpoint, this.promptEnvelope(msgId, peer.session_id, { prompt, hops, conversationId, responseSchema })).then(() => {
      // A concurrent cancel() during the ACK await deletes this pending; returning its
      // msg_id would hand the caller an immediately-unknown id. Surface the cancellation.
      if (this.pending.get(msgId) !== pending) throw new Error('relay: outbound request cancelled')
      if (!pending.result) this.armExpiry(msgId, pending)
      receipt.state = 'delivered'
      return msgId
    }).catch(error => {
      receipt.state = 'undeliverable'
      receipt.error = message(error)
      delete receipt.msgId
      this.forgetPending(msgId)
      throw error
    })
    return deliveryAttempt(receipt, delivery)
  }

  get(msgId: string, signal?: AbortSignal): ReplyResult {
    const pending = this.pending.get(msgId)
    if (!pending) return { status: 'error', error: 'unknown msg_id' }
    if (!pending.result) return { status: 'pending' }
    return { status: 'complete', ...this.readReply(msgId, pending.result, signal) }
  }

  async awaitReply(msgId: string, timeoutMs: number, signal?: AbortSignal): Promise<ReplyResult> {
    const pending = this.pending.get(msgId)
    if (!pending) return { status: 'error', error: 'unknown msg_id' }
    if (pending.result) return { status: 'complete', ...this.readReply(msgId, pending.result, signal) }
    const result = await withTimeout(pending.promise, timeoutMs, signal)
    if (result) return { status: 'complete', ...this.readReply(msgId, result, signal) }
    return { status: 'timeout', peers: this.coPeerCount() }
  }

  private readReply(msgId: string, result: Reply, signal?: AbortSignal): Reply {
    this.armReclaimAt(msgId, this.markReplyRead(msgId), signal)
    return result
  }

  private markReplyRead(msgId: string): number {
    this.observed.add(msgId)
    const generation = (this.replyReads.get(msgId) ?? 0) + 1
    this.replyReads.set(msgId, generation)
    return generation
  }

  async awaitInbound(timeoutMs: number, signal?: AbortSignal): Promise<InboundResult> {
    // Whole-method single flight: the fast paths below would hand the same active request
    // to parallel awaits (double-delivery), so the latch covers them, not just the waiter.
    // A sequential re-await after SDK cancellation still redelivers — that call arrives
    // after the previous one settled and released the latch.
    if (this.awaitingInbound) throw new Error('relay: inbound await already in flight')
    this.awaitingInbound = true
    this.recordAwait()
    try {
      // An unresponded active request stays redeliverable: the SDK suppresses results after cancellation
      if (this.activeInbound) return this.handInbound(inboundRequest(this.activeInbound))
      // Self-heal: a request stranded in `inbound` without a queue entry would be invisible forever.
      if (this.queue.length === 0 && this.inbound.size > 0) for (const prompt of this.inbound.values()) if (!this.delivering.has(prompt.msg_id)) this.queue.push(inboundRequest(prompt))
      if (signal?.aborted) {
        // Self-healed messages re-queued on an aborted await are undelivered NOW: without
        // this update they would sit invisible to the wake layer until unrelated traffic.
        this.wakeUpdate()
        return this.timedOut()
      }
      const queued = this.queue.shift()
      // After the shift so a self-healed message being delivered right now never counts
      // as undelivered (a spurious wake would burn budget on work already in hand).
      this.wakeUpdate()
      if (queued) return this.handInbound(queued)
      // Inbound outranks replies: an unanswered request blocks a peer, an unread
      // answer only blocks us.
      const ready = this.takeCompletedReply(signal)
      if (ready) return { status: 'complete', reply: ready }
      // A reply-completion wake that lost its reply to a concurrent keyed consumer must
      // re-park, not report a false timeout: only deadline exhaustion ends the wait.
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0 || signal?.aborted) return this.timedOut()
        let waiter!: (request: InboundRequest | undefined) => void
        const promise = new Promise<InboundRequest | undefined>(resolve => { waiter = resolve; this.inboundWaiter = resolve })
        const request = await withTimeout(promise, remaining, signal)
        if (this.inboundWaiter === waiter) this.inboundWaiter = undefined
        if (request) return this.handInbound(request)
        // An aborted wait must not surface (and instantly reclaim) a reply into a result
        // the client already suppressed — the loop head reports the timeout instead.
        if (signal?.aborted) continue
        // Inbound outranks replies on the wake path too: a request queued in the gap
        // between the waiter clearing and this recheck must win over a completed reply.
        if (this.activeInbound) return this.handInbound(inboundRequest(this.activeInbound))
        const arrived = this.queue.shift()
        this.wakeUpdate()
        if (arrived) return this.handInbound(arrived)
        const late = this.takeCompletedReply(signal)
        if (late) return { status: 'complete', reply: late }
      }
    } finally { this.awaitingInbound = false }
  }

  // Replies ride the same bare await that carries inbound requests, oldest first, one per
  // call: a requester that lost its msg_id (turn ended, await backgrounded then cancelled)
  // still receives every answer by staying in its loop. Surfacing consumes the reply for
  // await purposes; relay_poll re-reads it by msg_id until eviction.
  private takeCompletedReply(signal?: AbortSignal): SurfacedReply | undefined {
    for (const msgId of this.completed) {
      if (this.observed.has(msgId)) continue
      const pending = this.pending.get(msgId)
      if (!pending?.result) continue
      this.armReclaimAt(msgId, this.markReplyRead(msgId), signal)
      return { msg_id: msgId, ...pending.result }
    }
    return undefined
  }

  // The reply analog of the inbound handSeq reclaim: an await cancelled after its reply
  // resolved had the result suppressed client-side, so un-observing lets the next bare
  // await re-surface it. Every signal-bearing read arms its own reclaim, fenced at the
  // generation its read produced, so the fence can never be stolen by a concurrent read
  // racing the arm. Only the handoff holding the LATEST generation reclaims on abort:
  // both-cancelled restores unread state (no strand), a later read or poll voids earlier
  // reclaims (consumption proven), and unrelated awaits touch nothing. The residual trade
  // is deliberate: cancelling the newest of several reads re-surfaces a possibly-seen
  // reply once — a duplicate read is harmless, a lost reply is the bug this exists for.
  private armReclaimAt(msgId: string, fence: number, signal?: AbortSignal) {
    if (!signal) return
    const reclaim = () => {
      this.dropReclaimListener(msgId, reclaim)
      if ((this.replyReads.get(msgId) ?? 0) !== fence) return
      if (!this.pending.get(msgId)?.result) return
      this.observed.delete(msgId)
      // A requester parked in a bare await must not sleep through the restore: wake it
      // so the reclaimed reply surfaces now, not at the next loop cycle.
      const waiter = this.inboundWaiter
      this.inboundWaiter = undefined
      waiter?.(undefined)
    }
    if (signal.aborted) { reclaim(); return }
    signal.addEventListener('abort', reclaim, { once: true })
    // Tracked so consumption/eviction unregisters it: a long-lived host signal (one
    // residency controller across thousands of dispatches) must not accumulate one dead
    // closure per completed reply.
    let listeners = this.reclaimListeners.get(msgId)
    if (!listeners) { listeners = new Map(); this.reclaimListeners.set(msgId, listeners) }
    listeners.set(reclaim, signal)
  }

  private dropReclaimListener(msgId: string, reclaim: () => void) {
    const listeners = this.reclaimListeners.get(msgId)
    if (!listeners) return
    listeners.delete(reclaim)
    if (listeners.size === 0) this.reclaimListeners.delete(msgId)
  }

  private clearReclaimListeners(msgId: string) {
    const listeners = this.reclaimListeners.get(msgId)
    if (!listeners) return
    for (const [reclaim, signal] of listeners) signal.removeEventListener('abort', reclaim)
    this.reclaimListeners.delete(msgId)
  }

  // An empty await is ambiguous on its own: waiting on a live peer that has nothing to say
  // and waiting in a pool nobody else has registered into yet are byte-identical, and the
  // second is the implementation-cohort startup race  that strands every handoff.
  // Reporting the co-peer count makes the race self-diagnosing at the point it bites.
  private timedOut(): InboundResult {
    return { status: 'timeout', peers: this.coPeerCount() }
  }

  private coPeerCount() {
    return this.entries().filter(entry => entry.session_id !== this.sessionId).length
  }

  cancel(filter: { msgId?: string; target?: string } = {}) {
    // Break-glass: frees send slots even when the msg_id was lost to a renewal.
    // Completed-but-unread replies survive a bare or target cancel; only an explicit msg_id removes them.
    const cancelled: string[] = []
    for (const [msgId, pending] of this.pending) {
      if (filter.msgId && msgId !== filter.msgId) continue
      if (filter.target && pending.peerName !== filter.target && pending.sessionId !== filter.target) continue
      if (pending.result && !filter.msgId) continue
      if (!pending.result) { pending.result = { error: 'cancelled' }; pending.resolve(pending.result) }
      this.forgetPending(msgId)
      cancelled.push(msgId)
    }
    return cancelled
  }

  // For a caller that has given up answering: a reply the transport can never carry must
  // not stay redeliverable forever, or it starves every later inbound message.
  abandonInbound(msgId: string) {
    this.forgetInbound(msgId)
  }

  async respond(msgId: string, response: unknown) {
    const prompt = this.inbound.get(msgId)
    if (!prompt) throw new Error('relay: unknown or completed inbound msg_id')
    try {
      await this.sendEnvelope(prompt.sender_endpoint, this.responseEnvelope(msgId, response))
    } catch (error) {
      // Terminal failures abandon the request: an unreachable sender, or a sender that
      // rejected the correlation (expired/unknown pending) and will never accept a retry.
      // Oversize and transient failures keep the request redeliverable.
      if (error instanceof EndpointUnreachableError || isCorrelationRejection(error)) this.forgetInbound(msgId)
      throw error
    }
    this.forgetInbound(msgId)
  }

  private forgetInbound(msgId: string) {
    this.inbound.delete(msgId)
    this.delivering.delete(msgId)
    // A queued-but-never-handed request must go too, or a later await hands a phantom
    // whose prompt is gone and whose reply can never be accepted.
    const queued = this.queue.findIndex(request => request.msgId === msgId)
    if (queued >= 0) this.queue.splice(queued, 1)
    if (this.activeInbound?.msg_id === msgId) { this.activeInbound = undefined; this.activeUnseen = false; this.wakeUpdate() }
  }

  private handInbound(request: InboundRequest): InboundResult {
    this.delivering.add(request.msgId)
    this.activeInbound = this.inbound.get(request.msgId)
    // Being handed (again) means seen unless the LATEST holder reports a race.
    this.activeUnseen = false
    this.handSeq += 1
    this.wakeUpdate()
    return { status: 'complete', request, handSeq: this.handSeq }
  }

  private agentsDir() { return path.join(this.config.relayDir, 'projects', this.config.project, 'agents') }

  private async bind() {
    if (process.platform !== 'win32') {
      mkdirSync(path.dirname(this.endpoint), { recursive: true, mode: 0o700 })
      ensureRelaySocketDirectory(this.endpoint)
    }
    await this.clearStaleEndpoint()
    this.server = net.createServer(socket => {
      this.sockets.add(socket)
      // One envelope, one reply, close: a peer that withholds its FIN after our end() must
      // not retain the accepted socket forever, so every connection has a hard idle bound.
      socket.setTimeout(30_000, () => socket.destroy())
      socket.once('close', () => this.sockets.delete(socket))
      void this.receive(socket)
    })
    await new Promise<void>((resolve, reject) => this.server?.listen(this.endpoint, resolve).once('error', reject))
    this.socketIdentity = this.currentSocketIdentity()
    if (this.unrefed) this.server?.unref()
  }

  private currentSocketIdentity() {
    try { const stats = statSync(this.endpoint); return `${stats.dev}:${stats.ino}` }
    catch { return undefined }
  }

  // Never unlink an endpoint a live process still owns. An agent wedged in a long tool call
  // cannot accept, so a probe alone calls it stale and deleting its socket strands it with
  // no way back . Registry liveness fences the probe; the probe only sees corpses
  // whose owner never registered or is already gone.
  private async clearStaleEndpoint() {
    if (process.platform === 'win32') return
    const judged = this.currentSocketIdentity()
    if (!judged) return
    if (this.endpointOwnedByLivePeer() || await socketAlive(this.endpoint)) throw new EndpointContendedError(`relay: endpoint already in use (${this.endpoint})`)
    // The probe is asynchronous, so the corpse it judged may have been replaced by a live
    // successor while it ran: remove only the socket the verdict was actually about.
    if (this.currentSocketIdentity() === judged) rmSync(this.endpoint, { force: true })
  }

  private endpointOwnedByLivePeer() {
    return this.entries().some(entry => entry.endpoint === this.endpoint && entry.session_id !== this.sessionId)
  }

  private async receive(socket: net.Socket) {
    try {
      const envelope = parseEnvelope(await readLine(socket))
      if (envelope.type === 'prompt') return this.receivePrompt(socket, envelope)
      if (envelope.type === 'response') return this.receiveResponse(socket, envelope)
      return this.receivePing(socket, envelope)
    } catch (error) {
      // A deadline or transport error already destroyed the socket; a cap breach leaves it
      // writable so the sender gets its documented nack (writeLine ends the connection).
      if (!socket.destroyed) writeLine(socket, { type: 'nack', msg_id: '', error: message(error) })
    }
  }

  private receivePrompt(socket: net.Socket, prompt: Prompt) {
    if (typeof prompt.hops !== 'number' || prompt.hops >= maxHops) return nack(socket, prompt.msg_id, 'hops exceeded')
    if (!this.sameWorktree(prompt.sender_cwd)) return nack(socket, prompt.msg_id, 'sender cwd outside worktree')
    if (!this.sameRelayEndpoint(prompt.sender_endpoint, prompt.sender_session)) return nack(socket, prompt.msg_id, 'sender endpoint outside configured pool')
    if (this.inbound.has(prompt.msg_id)) return nack(socket, prompt.msg_id, 'duplicate inbound msg_id')
    if (this.inbound.size >= (this.config.inboundLimit ?? maxInbound)) return nack(socket, prompt.msg_id, 'inbound capacity reached')
    if (this.senderQuotaReached(prompt.sender_session)) return nack(socket, prompt.msg_id, 'sender inbound quota reached')
    this.inbound.set(prompt.msg_id, prompt)
    const request = inboundRequest(prompt)
    if (this.inboundWaiter) { this.delivering.add(prompt.msg_id); this.inboundWaiter(request) }
    else this.queue.push(request)
    this.inboundWaiter = undefined
    ack(socket, prompt.msg_id)
    // The delivery is committed and acknowledged before the wake layer hears about it.
    this.wakeUpdate()
  }

  private receiveResponse(socket: net.Socket, response: Response) {
    const pending = this.pending.get(response.msg_id)
    if (!pending || response.sender_session !== pending.sessionId || response.sender_endpoint !== pending.endpoint || !this.sameRelayEndpoint(response.sender_endpoint, response.sender_session)) return nack(socket, response.msg_id, 'response endpoint outside configured pool')
    if (!pending.result) {
      if (pending.expiry) clearTimeout(pending.expiry)
      pending.result = { response: response.response, error: response.error ?? undefined }
      pending.resolve(pending.result)
      this.armExpiry(response.msg_id, pending)
      this.completed.push(response.msg_id)
      while (this.completed.length > maxRetainedResults) {
        const observedIdx = this.completed.findIndex(id => this.observed.has(id))
        this.forgetPending(observedIdx >= 0 ? this.completed[observedIdx] : this.completed[0])
      }
      if (this.outbound.get(pending.peerName) === response.msg_id) this.outbound.delete(pending.peerName)
      // A requester blocked in a bare await must not sleep through its own answer:
      // resolve the waiter empty so the await re-checks completed replies now.
      const waiter = this.inboundWaiter
      this.inboundWaiter = undefined
      waiter?.(undefined)
    }
    ack(socket, response.msg_id)
  }

  private receivePing(socket: net.Socket, ping: Ping) {
    if (!this.sameRelayEndpoint(ping.sender_endpoint, ping.sender_session)) return nack(socket, ping.msg_id, 'sender endpoint outside configured pool')
    const contextUsedPct = currentContextUsage(this.contextUsedPct, this.contextReportedAt)
    writeLine(socket, { type: 'pong', msg_id: ping.msg_id, agent_card: { name: this.resolvedName, purpose: this.config.purpose, model: this.config.model, color: this.config.color ?? '#36F9F6', ...(contextUsedPct === undefined ? {} : { context_used_pct: contextUsedPct }), queue_depth: this.queueDepth(), ...this.wakeFields() } })
  }

  // Additive and gate-dependent: with the wake layer off these fields do not exist
  // anywhere (registry or pong), keeping legacy output byte-identical.
  private wakeFields() {
    const snapshot = this.wake?.snapshot()
    if (!snapshot) return {}
    return { undelivered_depth: snapshot.undelivered, ...(snapshot.episodeId ? { undelivered_episode_id: snapshot.episodeId } : {}), ...(snapshot.tier1 ? { wake_tier1: snapshot.tier1 } : {}) }
  }

  private entries() { return pruneDeadEntries(this.agentsDir(), sessionId => relayEndpoint(this.config.relayDir, sessionId)) }

  private reserveName() {
    this.entries()
    for (let suffix = 1; ; suffix++) {
      const name = suffix === 1 ? this.config.name : `${this.config.name}${suffix}`, file = path.join(this.agentsDir(), `${name}.json`)
      reclaimInvalidRegistryFile(file)
      try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); this.resolvedName = name; this.registryFile = file; return }
      catch (error: any) { if (error?.code !== 'EEXIST') throw error }
    }
  }

  private target(identifier: string) {
    const entries = this.entries()
    const target = entries.find(entry => entry.name === identifier) ?? entries.find(entry => entry.session_id === identifier)
    if (!target) throw new Error(`relay: no live agent matching "${identifier}"`)
    if (!this.sameWorktree(target.cwd)) throw new Error('relay: target cwd outside worktree')
    if (!this.sameRelayEndpoint(target.endpoint, target.session_id)) throw new Error('relay: target endpoint outside configured pool')
    return target
  }

  private sameWorktree(candidate: string) { return typeof candidate === 'string' && path.isAbsolute(candidate) && inside(this.config.worktree, candidate) }
  private sameRelayEndpoint(endpoint: string, sessionId: string) { const expected = relayEndpoint(this.config.relayDir, sessionId); return typeof endpoint === 'string' && endpoint === expected && (process.platform === 'win32' || inside(relaySocketDirectory(this.config.relayDir, sessionId), expected)) }

  // Unregistered senders share one bucket: rotating fabricated session ids must not
  // multiply the quota, while each registered peer keeps its own allowance.
  private senderQuotaReached(senderSession: string) {
    const registered = new Set(this.entries().map(entry => entry.session_id))
    const keyOf = (session: string) => registered.has(session) ? session : 'unregistered'
    const key = keyOf(senderSession)
    return [...this.inbound.values()].filter(held => keyOf(held.sender_session) === key).length >= senderQuota
  }

  private queueDepth() { return this.inbound.size }

  private heartbeatTick() {
    void this.ensureBound().catch(() => relayHost().logger.warn('relay endpoint rebind failed; retrying on the next heartbeat'))
    try { if (!this.writeRegistry()) this.notifyOwnershipLoss() }
    catch { relayHost().logger.warn('relay heartbeat write failed') }
  }

  private armExpiry(msgId: string, pending: Pending) {
    pending.expiry = setTimeout(() => this.forgetPending(msgId), Math.min(this.config.outboundExpiryMs ?? outboundExpiryMs, MAX_TIMER_MS))
    pending.expiry.unref()
  }

  private forgetPending(msgId: string) {
    const pending = this.pending.get(msgId)
    if (pending?.expiry) clearTimeout(pending.expiry)
    this.pending.delete(msgId)
    this.observed.delete(msgId)
    this.replyReads.delete(msgId)
    this.clearReclaimListeners(msgId)
    const retained = this.completed.indexOf(msgId)
    if (retained >= 0) this.completed.splice(retained, 1)
    for (const [peerName, id] of this.outbound) if (id === msgId) this.outbound.delete(peerName)
  }

  private writeRegistry(): boolean {
    // A registry entry names the endpoint peers will connect to, so the tree holding it must
    // be as private as the sockets: the heartbeat recreates it after a base is deleted, and
    // an unmoded mkdir would rebuild it group-writable under the default umask.
    mkdirSync(this.agentsDir(), { recursive: true, mode: 0o700 })
    if (!this.ownsRegistryFile()) { relayHost().logger.warn(`relay registry name "${this.resolvedName}" lost to another session; not overwriting`); return false }
    const entry: RegistryEntry = { session_id: this.sessionId, name: this.resolvedName, purpose: this.config.purpose, model: this.config.model, color: this.config.color ?? '#36F9F6', pid: process.pid, endpoint: this.endpoint, cwd: this.config.worktree, started_at: now(), explicit: false, version: 1, ...(this.contextUsedPct === undefined ? {} : { context_used_pct: this.contextUsedPct, context_reported_at: this.contextReportedAt! }), queue_depth: this.queueDepth(), heartbeat_at: now(), heartbeat_ms: this.config.heartbeatMs ?? heartbeatMs, implementation: `${RELAY_MCP_SERVER_NAME}@${RELAY_MCP_CONTRACT_VERSION}`, ...(this.lastAwaitAt ? { last_await_at: this.lastAwaitAt } : {}), ...this.wakeFields() }
    const temporary = `${this.registryFile}.tmp`
    writeFileSync(temporary, JSON.stringify(entry, null, 2))
    renameSync(temporary, this.registryFile)
    return true
  }

  private promptEnvelope(msgId: string, recipientSession: string, options: PromptOptions): Prompt {
    const envelope: Prompt = { type: 'prompt', msg_id: msgId, sender_session: this.sessionId, sender_endpoint: this.endpoint, sender_name: this.resolvedName, sender_cwd: this.config.worktree, hops: options.hops, timestamp: now(), prompt: options.prompt, conversation_id: options.conversationId ?? null, response_schema: options.responseSchema ?? null }
    // Possession proof: the tag binds message id, sender identity, recipient, and
    // content; the credential itself never travels. Unsigned envelopes stay valid — the
    // receiver labels them unverified instead of dropping them.
    if (this.config.credential) envelope.credential_tag = signPayload(this.config.credential, credentialPayload(msgId, this.sessionId, this.resolvedName, recipientSession, options.prompt))
    return envelope
  }

  private responseEnvelope(msgId: string, response: unknown): Response {
    return { type: 'response', msg_id: msgId, sender_session: this.sessionId, sender_endpoint: this.endpoint, hops: 0, timestamp: now(), response, error: null }
  }

  private async ping(entry: RegistryEntry) {
    if (!this.sameWorktree(entry.cwd) || !this.sameRelayEndpoint(entry.endpoint, entry.session_id)) return false
    try {
      const response = await this.sendEnvelope(entry.endpoint, { type: 'ping', msg_id: randomUUID(), sender_session: this.sessionId, sender_endpoint: this.endpoint, hops: 0, timestamp: now() })
      return response.type === 'pong'
    } catch { return false }
  }

  private async sendEnvelope(endpoint: string, envelope: Envelope) {
    // The recipient enforces the encoded-line cap by destroying the connection; failing
    // here instead turns an oversized payload into an actionable error before dialing.
    if (Buffer.byteLength(JSON.stringify(envelope)) + 1 > lineCap) throw new Error(`relay: envelope exceeds the ${lineCap}-byte transport line cap`)
    const socket = await connect(endpoint)
    try {
      writeLine(socket, envelope)
      const response = parseTransportReply(await readLine(socket))
      if (response.msg_id !== envelope.msg_id) throw new Error('mismatched acknowledgement')
      if (response.type === 'nack') throw new NackError(response.error ?? 'nack')
      if (response.type !== (envelope.type === 'ping' ? 'pong' : 'ack')) throw new Error('invalid acknowledgement')
      return response
    } finally { socket.destroy() }
  }
}

function validateConfig(config: RelayAdapterConfig, runtimeCwd: string) {
  if (!segment(config.project) || !segment(config.name) || (config.sessionId !== undefined && !segment(config.sessionId))) throw new Error('relay: project, name, and session identity must be safe path segments')
  if (!path.isAbsolute(config.relayDir) || !path.isAbsolute(config.worktree)) throw new Error('relay: MODULA_RELAY_DIR and worktree must be absolute')
  const worktree = path.resolve(config.worktree)
  if (!path.isAbsolute(runtimeCwd) || !inside(worktree, runtimeCwd)) throw new Error('relay: local cwd outside configured worktree')
  if (!positive(config.inboundLimit) || !positive(config.outboundExpiryMs) || !positive(config.heartbeatMs)) throw new Error('relay: limits must be positive integers')
  return { ...config, relayDir: path.resolve(config.relayDir), worktree }
}

// A probe that neither connects nor errors means a listener holds the socket with a full
// backlog: report it alive. Treating that silence as "stale" is what deleted live agents'
// endpoints , and an unbounded wait would hang the bind instead.
const probeTimeoutMs = 1_000
async function socketAlive(endpoint: string) {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection({ path: endpoint })
    const settle = (alive: boolean) => { clearTimeout(timer); socket.destroy(); resolve(alive) }
    const timer = setTimeout(() => settle(true), probeTimeoutMs)
    timer.unref()
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}
function required(value: string | undefined, name: string) { if (!value) throw new Error(`relay: ${name} is required`); return value }

// A registry file that never became a valid entry — a crash between name reservation and
// the first registry write, or a truncated foreign write — is unreachable by ping and never
// pruned, so it would hold the name forever. The grace window keeps a concurrent peer's own
// reservation-to-write gap safe from reclaim. Reclamation is single-winner: the rename is
// the atomic claim (a losing racer gets ENOENT and backs off), what is actually held is
// re-validated, and restoration uses link so it can never overwrite a fresh reservation.
// This guards accidental races only — the per-user 0o700 directory is the trust boundary.
const RECLAIM_GRACE_MS = 10_000
function reclaimInvalidRegistryFile(file: string) {
  if (!invalidBeyondGrace(file, file)) return
  const claim = `${file}.reclaim`
  try { renameSync(file, claim) } catch { return }
  if (invalidBeyondGrace(claim, file)) return rmSync(claim, { force: true })
  try { linkSync(claim, file) } catch { /* name re-taken; the live owner's heartbeat restores its entry */ }
  rmSync(claim, { force: true })
}

function invalidBeyondGrace(candidate: string, registryPath: string) {
  let raw: string
  try { raw = readFileSync(candidate, 'utf8') } catch { return false }
  try { if (validRegistryEntry(JSON.parse(raw) as RegistryEntry, registryPath)) return false }
  catch { /* unparsable: fall through to the grace check */ }
  try { return Date.now() - statSync(candidate).mtimeMs > RECLAIM_GRACE_MS } catch { return false }
}
function segment(value: string) { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) }
// Node coerces a setTimeout delay above the signed-32-bit ceiling to 1ms, so a value
// past it would expire retained replies almost immediately. Reject/clamp at that bound.
const MAX_TIMER_MS = 2_147_483_647
function positive(value: number | undefined) { return value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_MS) }
function positiveInt(value: string | undefined) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : undefined }
function validContextUsage(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 }
function now() { return new Date().toISOString() }
class NackError extends Error {}
// A bind refused because a live owner (registry-fenced or probe-alive) already holds the
// path — distinct from a transient bind failure, so a rebind can surrender rather than retry.
class EndpointContendedError extends Error {}

function isCorrelationRejection(error: unknown) {
  return error instanceof NackError && error.message === 'response endpoint outside configured pool'
}

function message(error: unknown) { return error instanceof Error ? error.message : 'invalid envelope' }
function inside(root: string, candidate: string) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
function publicEntry(entry: RegistryEntry, project: string) {
  const contextUsedPct = currentContextUsage(entry.context_used_pct, entry.context_reported_at)
  return { name: entry.name, session_id: entry.session_id, purpose: entry.purpose, model: entry.model, cwd: entry.cwd, project, ...(contextUsedPct === undefined ? {} : { context_used_pct: contextUsedPct }), color: entry.color, ...(entry.last_await_at ? { last_await_at: entry.last_await_at } : {}) }
}

// Two of the peer's own heartbeat periods plus one await window: last_await_at is
// published on the heartbeat cadence, so the threshold must scale with the interval the
// PEER declares — a fixed cutoff reports any slow-heartbeat peer idle while it loops
// faithfully. Default heartbeat (30s) yields the original 120s threshold.
function staleAwaitThresholdMs(peer: RegistryEntry) {
  const declared = typeof peer.heartbeat_ms === 'number' && peer.heartbeat_ms > 0 ? peer.heartbeat_ms : heartbeatMs
  return 2 * declared + 60_000
}

function idleTargetNote(peer: RegistryEntry): { note?: string } {
  const last = peer.last_await_at ? Date.parse(peer.last_await_at) : Number.NaN
  if (Number.isFinite(last) && Date.now() - last <= staleAwaitThresholdMs(peer)) return {}
  return { note: `"${peer.name}" has not awaited recently; the message queues until it runs relay_await` }
}
function inboundRequest(prompt: Prompt): InboundRequest { return { msgId: prompt.msg_id, senderName: prompt.sender_name, senderSession: prompt.sender_session, senderCwd: prompt.sender_cwd, prompt: prompt.prompt, conversationId: prompt.conversation_id, responseSchema: prompt.response_schema, credentialTag: typeof prompt.credential_tag === 'string' ? prompt.credential_tag : undefined } }
function deferred(sessionId: string, endpoint: string, peerName: string): Pending { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(done => { resolve = done }); return { resolve, promise, sessionId, endpoint, peerName } }
function failedDelivery(target: string, error: unknown): DeliveryAttempt {
  const delivery = Promise.reject(error)
  return deliveryAttempt({ state: 'undeliverable', target, error: message(error) }, delivery)
}
function deliveryAttempt(receipt: DeliveryReceipt, delivery: Promise<string>): DeliveryAttempt {
  // A caller may inspect an immediate receipt and decide not to await it; record the rejection
  // as observed without changing the promise returned to callers that do await it.
  void delivery.catch(() => undefined)
  return Object.assign(delivery, { receipt })
}
function closeServer(server: net.Server | undefined) { return !server ? Promise.resolve() : new Promise<void>(resolve => server.close(() => resolve())) }
function writeLine(socket: net.Socket, value: unknown) { socket.end(`${JSON.stringify(value)}\n`) }
function ack(socket: net.Socket, msgId: string) { writeLine(socket, { type: 'ack', msg_id: msgId }) }
function nack(socket: net.Socket, msgId: string, error: string) { writeLine(socket, { type: 'nack', msg_id: msgId, error }) }
