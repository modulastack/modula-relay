// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
// Public interface of the relay package. A host consumes the relay core only through
// this surface; the package imports nothing host-internal (its one inbound dependency is
// the injected RelayHost).

export { RelayAdapter, wakeEnabledForRole, RELAY_WAKE_ROLES_ENV } from './relayAdapter.js'
export type { DeliveryAttempt, DeliveryReceipt, InboundRequest, RelayAdapterConfig, WakeConfig } from './relayAdapter.js'
export { withTimeout } from './relayTransport.js'
export {
  RELAY_CONTEXT_USAGE_METHOD,
  RELAY_MCP_CONTRACT_VERSION,
  RELAY_MCP_SERVER_NAME,
  RELAY_WAKE_ACK_METHOD,
  RELAY_WAKE_NOTIFICATION_METHOD,
  RELAY_WAKE_STATE_METHOD,
} from './relayContract.js'
export {
  relayEndpoint,
  isSafePathSegment,
  ensureRelayRuntimeDirectory,
  RELAY_RUNTIME_DIR_ENV,
  RELAY_RUNTIME_DIR_REQUIRED_ENV,
} from './relayEndpoint.js'
export {
  credentialPayload,
  issueTurnId,
  parseTurnOutput,
  sessionCredentialFor,
  turnEnvelope,
  turnProtocolEnabled,
  verifyPayload,
  initSessionCredentialKey,
  sessionCredentialEnv,
} from './agentTurnProtocol.js'
export { startRelayServer, recordStartupFailure, redactInbound } from './relayServer.js'
export { configureRelayHost, relayHost } from './host.js'
export type { RelayHost, RelayLogger } from './host.js'
export { currentContextUsage, CONTEXT_USAGE_EXPIRY_MS, CONTEXT_USAGE_FUTURE_SKEW_MS } from './contextUsage.js'
