// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
// The RelayHost is the relay core's only inbound platform surface: the package imports
// nothing platform-internal, and the host supplies the one capability the protocol cannot
// own itself — a logger. The platform configures it once at startup; the no-op default keeps
// the package usable (and testable) standalone.

export interface RelayLogger {
  warn(message: string): void
}

export interface RelayHost {
  logger: RelayLogger
}

const noopHost: RelayHost = {
  logger: { warn() {} },
}

let current: RelayHost = noopHost

export function configureRelayHost(host: RelayHost): void {
  current = host
}

export function relayHost(): RelayHost {
  return current
}
