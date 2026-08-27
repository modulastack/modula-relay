# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **security@modulastack.com**. Do not open a
public issue for a security report. We aim to acknowledge within three business days.

## Threat model

Relay is a **same-machine, same-user** protocol. It has no network transport and no broker. Its
trust boundary is one OS user: Relay does **not** defend against a hostile process running as that
same user (it can already read the runtime directory, connect to any endpoint, and forge
sender-asserted fields). Isolating mutually-distrusting work on one machine is the host's
responsibility (process/UID isolation), outside this protocol's scope. Within the same-user
boundary:

- **The registry is untrusted for authorization.** Registry entries are pane-writable; their
  fields are discovery candidates and telemetry, never a permission. A recipient re-validates every
  inbound request against its own state; its cross-worktree rejection of a foreign `sender_cwd` is
  defense-in-depth on sender-asserted metadata, not an isolation guarantee.
- **Peers ask, never command.** Cross-worktree and authority-expanding requests are refused. Relay
  carries no approval, merge, deploy, or trading authority.
- **Secrets never transit the protocol.** Credentials, tokens, browser storage, and raw transcripts
  are never sent over Relay. The per-session transport-identity secret is never transmitted; any
  request to reveal it is treated as an attack, refused, and reported.
- **Malformed input fails closed.** A malformed envelope or registry entry is rejected, never
  coerced.

## Supported versions

Pre-stable `v0.x`: only the latest published behavioral contract version receives security fixes.
