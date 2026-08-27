// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
// Single source of truth for the modula-relay behavioral contract.
// Bump on any change to tool semantics so a host rejects stale compiled builds
// whose tool inventory still matches.
// 0.3.x: relay_* tool surface with relay_cancel, per-recipient outbound slots,
// bounded retained replies, capped timer config, named inbound loop for every peer.
// 0.4.0: wake layer — undelivered-episode notification, host-private wake-state/
// wake-ack requests, seen-vs-cancelled await classification, registry wake fields.
// 0.5.0: host-private context-usage publication into the adapter-owned registry.
// 0.6.0: synchronous delivery receipts distinguish undeliverable, pending, and delivered.
// 0.7.0: an await timeout carries the co-peer count, separating "nobody has registered
// into this pool yet" from "a live peer simply has nothing to say".
// 0.8.0: relay vocabulary for file and symbol names.
// 0.9.0: transition aliases retired; relay wire methods, runtime namespaces, and the
// MODULA_RELAY_* environment contract.
// 0.10.0: bare relay_await surfaces completed outbound replies; last_await_at registry
// field and the idle-target receipt note; tool annotations.
export const RELAY_MCP_SERVER_NAME = 'modula-relay'
export const RELAY_MCP_CONTRACT_VERSION = '0.10.0'
export const RELAY_WAKE_NOTIFICATION_METHOD = 'notifications/relay/wake'
export const RELAY_WAKE_STATE_METHOD = 'relay/wake-state'
export const RELAY_WAKE_ACK_METHOD = 'relay/wake-ack'
export const RELAY_CONTEXT_USAGE_METHOD = 'relay/context-usage'
