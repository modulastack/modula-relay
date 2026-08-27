// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
import { randomUUID } from 'node:crypto'

// Tier-1 wake state, owned by the recipient's own adapter (the lease authority).
// An episode spans one empty→non-empty stretch of undelivered work; its id is what
// keeps attempt caps from leaking across drain-and-refill boundaries. The persistent
// budget spans episodes: a sender minting one message per drain cycle stops
// accelerating at the budget, never at the episode cap alone.

export type WakeEvent = { episodeId: string; undelivered: number; attempt: number }
export type Tier1WakeState = 'armed' | 'held' | 'emitted' | 'retrying' | 'exhausted' | 'dropped'
export type WakeSnapshot = { undelivered: number; episodeId?: string; tier1?: { state: Tier1WakeState; leaseUntil: number } }
export type WakeTrackerOptions = { onWake: (event: WakeEvent) => void; graceMs?: number; attemptCap?: number; budgetPerHour?: number; leaseMs?: number; clock?: () => number }

const GRACE_MS = 60_000
const ATTEMPT_CAP = 3
const BUDGET_PER_HOUR = 10
const HOUR_MS = 3_600_000

export class WakeTracker {
  private readonly onWake: (event: WakeEvent) => void
  private readonly graceMs: number
  private readonly attemptCap: number
  private readonly budgetPerHour: number
  private readonly leaseMs: number
  private readonly clock: () => number
  private episodeId?: string
  private attempts = 0
  private undelivered = 0
  private tokens: number
  private lastRefill: number
  private timer?: NodeJS.Timeout
  private tier1?: { state: Tier1WakeState; leaseUntil: number }

  constructor(options: WakeTrackerOptions) {
    this.onWake = options.onWake
    this.graceMs = options.graceMs ?? GRACE_MS
    this.attemptCap = options.attemptCap ?? ATTEMPT_CAP
    this.budgetPerHour = options.budgetPerHour ?? BUDGET_PER_HOUR
    this.leaseMs = options.leaseMs ?? 2 * this.graceMs
    this.clock = options.clock ?? Date.now
    this.tokens = this.budgetPerHour
    this.lastRefill = this.clock()
  }

  update(undelivered: number) {
    this.undelivered = undelivered
    if (undelivered === 0) return this.endEpisode()
    if (!this.episodeId) {
      // Rotation on every empty→non-empty transition resets the attempt cap for
      // legitimate progression; it never refills the budget.
      this.episodeId = randomUUID()
      this.attempts = 0
      this.tier1 = undefined
      this.fire()
    }
  }

  // The bridge owns arm/hold/emit/drop; the tracker records its acknowledged state and
  // grants the lease. A stale-episode ack is refused so a late bridge cannot resurrect
  // state for work that already drained.
  ack(episodeId: string, state: Tier1WakeState): number | undefined {
    if (!this.episodeId || episodeId !== this.episodeId) return undefined
    const leaseUntil = this.clock() + (state === 'exhausted' || state === 'dropped' ? 0 : this.leaseMs)
    this.tier1 = { state, leaseUntil }
    return leaseUntil
  }

  snapshot(): WakeSnapshot {
    return { undelivered: this.undelivered, ...(this.episodeId ? { episodeId: this.episodeId } : {}), ...(this.tier1 ? { tier1: this.tier1 } : {}) }
  }

  close() {
    this.clearTimer()
  }

  private endEpisode() {
    this.episodeId = undefined
    this.attempts = 0
    this.tier1 = undefined
    this.clearTimer()
  }

  private fire() {
    if (!this.episodeId || this.undelivered === 0) return
    if (this.attempts >= this.attemptCap || !this.consumeToken()) return this.goQuiet()
    this.attempts += 1
    this.onWake({ episodeId: this.episodeId, undelivered: this.undelivered, attempt: this.attempts })
    this.clearTimer()
    this.timer = setTimeout(() => this.fire(), this.graceMs)
    this.timer.unref()
  }

  private goQuiet() {
    // Past the cap or budget the episode stops re-firing; stalled-peer visibility is
    // tier 2's job (dock surfacing), never more nudges.
    if (this.episodeId && this.tier1?.state !== 'dropped') this.tier1 = { state: 'exhausted', leaseUntil: this.clock() }
    this.clearTimer()
  }

  private consumeToken() {
    const now = this.clock()
    this.tokens = Math.min(this.budgetPerHour, this.tokens + ((now - this.lastRefill) / HOUR_MS) * this.budgetPerHour)
    this.lastRefill = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
