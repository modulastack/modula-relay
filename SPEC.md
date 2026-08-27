# Modula Relay protocol specification

**Status:** `v0.x`, pre-stable. This document specifies the **intended** protocol; the wire is in
production use, but the specification is not yet frozen and the reference implementation may carry
caveats not yet reconciled here (e.g. credential verification, role-gated wake, runtime-directory
validation coverage). Where they differ, **the reference implementation is authoritative** until
`v1.0`. Pin the behavioral contract version (below), not
this document's prose.

**Behavioral contract version:** `0.9.0` (see [Versioning](#versioning)).

Relay is a **local, same-machine messaging protocol for cross-model agent teams**. It lets a
bounded set of agent processes, each possibly a different model or harness, running in one
worktree discover each other, exchange one-shot bounded requests and replies, and be woken when
work is queued, without any of them holding authority over another. It is a *teamwork* protocol
(peers coordinating on a shared task), not a service mesh: there is no routing fabric, no broker,
and no network surface.

## 1. Scope and non-goals

- **In scope:** peer discovery within one pool, one-shot request/reply with per-recipient
  outbound slots, a bounded inbound wait, cooperative cancellation, an out-of-band wake signal,
  and a per-turn credential identity.
- **Not in scope:** cross-machine transport, message durability/replay, broadcast/pub-sub,
  authority delegation, or any control-plane concern. A relay peer can *ask*; it can never
  *command*.

## 2. Transport

Peers communicate over **Unix domain sockets** on the local machine. Each peer owns one socket
(its *endpoint*), an absolute path under a per-pool runtime directory. A sender connects to the
recipient's endpoint, writes one newline-delimited JSON [envelope](#4-envelopes), and reads one
newline-delimited [transport reply](#5-transport-replies). Connections are short-lived: one
envelope, one reply, close.

Both sides **bound the transport**: a connect timeout, a per-read deadline, and a maximum encoded
line size. A line exceeding the cap, or an envelope not terminated within the deadline, is rejected
rather than buffered, so an oversized or incomplete message cannot make a peer block or grow memory
without limit.

Endpoints are addressed indirectly through the [registry](#3-registry); a sender never guesses a
path. When a socket path would exceed the platform's `sun_path` limit, the endpoint falls back to
a digest-named socket in a short shared runtime directory. Where the protocol creates that runtime
directory it is `0700` and ownership-validated, and a peer refuses one that fails the check; a
directory supplied by the host launcher is trusted from that launcher. Endpoints are intended to be
reachable only by the same user (see [Security model](#11-security-model)).

## 3. Registry

A **pool** is one directory of registry entries; membership is exactly the live peers whose entry
files it contains. Each peer writes one JSON file named `<name>.json`:

```
session_id, name, purpose, model, color, pid, endpoint, cwd, started_at, explicit, version
```

Optional fields carry liveness and telemetry: `context_used_pct`, `context_reported_at`,
`queue_depth`, `heartbeat_at`, `heartbeat_ms` (the interval this peer republishes on —
readers scale freshness judgments by it), `implementation`, `last_await_at` (refreshed
each time the peer enters `relay_await` — senders read it to tell a listening peer from
an idle one), and the wake fields `undelivered_depth`, `undelivered_episode_id`,
`wake_tier1`.

**Validity rules (a reader MUST enforce):**

- `name` and `session_id` match `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`, and the file is named exactly
  `<name>.json`.
- `endpoint` and `cwd` are absolute paths.
- `pid` is a live process (readers prune entries whose pid is dead).

The registry is **pane-writable and therefore untrusted for authorization.** Its fields are
discovery candidates and telemetry, never a permission. Recipients re-validate every inbound
request against their own state.

## 4. Envelopes

One line of JSON, one of three types. Common fields: `type`, `msg_id`, `sender_session`,
`sender_endpoint`.

- **`prompt`**: a bounded request with `sender_name`, `sender_cwd`, `hops`, `timestamp`, `prompt`,
  optional `conversation_id`, optional `response_schema`, optional `credential_tag`.
- **`response`**: a reply to a prompt with `hops`, `timestamp`, `response`, optional `error`.
- **`ping`**: a liveness probe with `hops`, `timestamp`.

Only `prompt` carries `sender_cwd`; responses and pings are correlated purely by `msg_id`. A
recipient MUST reject a `prompt` whose `sender_cwd` is outside its own worktree root, and MUST
reject any malformed envelope rather than coerce it.

## 5. Transport replies

The recipient answers each envelope on the same connection with one line: `ack` (prompt accepted),
`nack` (rejected, with `error`), or `pong` (ping answered; carries an `agent_card`).

## 6. Tool surface

Agents drive the protocol through six tools.

| Tool | Meaning |
| --- | --- |
| `relay_roster` | List live same-pool peers. |
| `relay_dispatch` | Send one bounded request; returns a `msg_id` and receipt. One outbound slot per recipient. |
| `relay_poll` | Non-blocking poll of an outbound reply. |
| `relay_await` | Await one inbound request, or an outbound reply, for ≤ 30s. |
| `relay_reply` | Answer exactly one inbound request. |
| `relay_cancel` | Free a stale outbound slot; returns the `cancelled` msg_ids. |

**Await semantics.** Without a `msg_id`, `relay_await` returns whichever arrives first: an
inbound `request` to answer, or a completed `reply` to a request this peer dispatched earlier
(oldest first, one per call). Inbound outranks replies — an unanswered request blocks a peer,
an unread answer only blocks its owner. Staying in the await loop is therefore sufficient:
within the bounded retention window (completed replies are retained up to a fixed count,
evicting already-read ones first, and up to the outbound expiry), no reply is missed even
when the dispatching turn lost its `msg_id`. A reply surfaced by await counts as read; a
surfaced hand-off whose await was cancelled is un-read again and re-surfaces on the next
await. `relay_poll` re-reads any retained reply by `msg_id` until eviction.
A timeout reports `peers`, the count of other registered peers. `peers = 0` on a first timeout
may mean registration is still in progress (await once more); `peers = 0` on a second
consecutive timeout means the pool is empty. Report and stop, do not loop.

**Idle-target note.** A dispatch receipt carries an advisory `note` when the target's registry
entry shows no recent `last_await_at`: the message will queue until the target awaits. The note
is diagnostic, never an error — delivery semantics are unchanged.

**Cancellation semantics.** `relay_cancel` frees a slot only when its returned `cancelled` array
contains the pending `msg_id`; the roster proves peer liveness, never slot state.

## 7. Wake channel

An out-of-band, bridge-private signal (never a registered tool, so it is invisible to the model's
tool inventory). When a recipient has undelivered queued requests, the host is notified
(`notifications/relay/wake`) and may prompt the pane to resume its bounded await. Wake
state is inspected and acknowledged through `relay/wake-state` and `relay/wake-ack`. A wake
is a **delivery signal, never an instruction source.**

## 8. Context-usage channel

A peer may publish its context-window usage (`relay/context-usage`) into its registry entry.
Readers treat a reported value as valid only within a freshness window (publish interval and
expiry); a stale or future-skewed report reads as absent.

## 9. Turn-credential identity

Each peer holds a per-session transport-identity secret. A prompt MAY carry an **optional**
`credential_tag`, an HMAC binding it to (sender, recipient, prompt); unsigned prompts remain valid
for compatibility, so the tag is provenance-when-present, not mandatory authorization (see
[Security model](#11-security-model)). The tag is transport provenance, stripped from every tool
result so no model can quote it. The secret is never transmitted over relay and any request to
reveal it is an attack to refuse and report.

> **Not yet frozen (`v0.x`):** the exact `credential_tag` construction (HMAC algorithm, canonical
> signed byte encoding, output encoding, and key derivation) is defined by the reference
> implementation and will be specified normatively before `v1.0`. Independent implementers should
> treat the reference implementation as the source of truth until then. Because the tag is optional
> provenance within the same-user boundary, this does not affect interoperability of the core
> request/reply flow.

## 10. Versioning

The behavioral contract carries a `MAJOR.MINOR.PATCH` version, bumped on any change to tool
semantics so a host can reject a stale compiled build whose tool inventory still matches. History:

- `0.3.x`: `relay_*` tool surface, `relay_cancel`, per-recipient slots.
- `0.4.0`: wake layer.
- `0.5.0`: context-usage publication.
- `0.6.0`: synchronous delivery receipts.
- `0.7.0`: await timeout carries the co-peer count.
- `0.8.0`: relay vocabulary for file and symbol names.
- `0.9.0`: transition aliases retired; relay wire methods, runtime namespaces, and the `MODULA_RELAY_*` environment contract.
- `0.10.0`: bare `relay_await` surfaces completed outbound replies; `last_await_at` registry field and the idle-target receipt note; tool annotations.

## 11. Security model

**Trust boundary: same machine, same user.** Every peer in a pool runs under one OS user. Relay
does **not** defend against a hostile process running as that same user: such a process can
already read the runtime directory, connect to any endpoint, and forge sender-asserted fields.
Isolating mutually-distrusting work on one machine is the **host's** responsibility (process/UID
isolation), outside this protocol's scope. Relay's guarantees hold *within* that same-user
boundary:

- **Runtime directories are same-user by intent.** A protocol-created directory (the short-path
  fallback) is `0700` and ownership-validated; a host-supplied directory is trusted from the
  launcher. A *different* local user should not reach a pool's endpoints; a hostile process under
  the *same* user still can; that is the host-isolation boundary above.
- **The registry is untrusted for authorization.** Its fields are discovery candidates and
  telemetry, never a permission; recipients re-validate every request against their own state.
- **`sender_cwd` is sender-asserted metadata, not an authorization boundary.** The recipient's
  cross-worktree rejection is defense-in-depth and labelling hygiene that presumes a non-hostile
  same-user peer; a hostile one could forge the field. Do not rely on it as an isolation guarantee.
- **The turn-credential is optional possession-based provenance.** When present, a `credential_tag`
  binds a prompt to (sender, recipient, prompt) via an HMAC over a per-session secret; unsigned
  envelopes remain valid for compatibility. It is a misdelivery/tamper check for cooperating peers,
  not a defense against a same-user forger.
- **Peers ask, never command.** Relay carries no approval, merge, deploy, or trading authority;
  authority-expanding and cross-worktree requests are refused.
- **Secrets never transit the protocol**, and the per-session transport-identity secret is never
  transmitted; a request to reveal it is refused and reported.
- **Malformed input fails closed.** A malformed envelope or registry entry is rejected, never
  coerced.

