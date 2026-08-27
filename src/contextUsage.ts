// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ModulaStack
// Peer context-usage freshness is relay protocol logic — a reported context% is valid only
// within the publish/expiry window — so the package owns it rather than taking it from the
// host. The platform re-exports these from shared/contextUsage.ts for its own context reader.
export const CONTEXT_USAGE_EXPIRY_MS = 90_000
export const CONTEXT_USAGE_FUTURE_SKEW_MS = 5_000

export function currentContextUsage(value: unknown, contextReportedAt: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return undefined
  if (typeof contextReportedAt !== 'string') return undefined
  const reportedAt = Date.parse(contextReportedAt)
  if (!Number.isFinite(reportedAt) || reportedAt > now + CONTEXT_USAGE_FUTURE_SKEW_MS || now - reportedAt > CONTEXT_USAGE_EXPIRY_MS) return undefined
  return value
}
