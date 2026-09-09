# Security

## Reporting a vulnerability

Please report security issues privately — do not open a public issue. Email
the maintainer via the repository contact, or open a GitHub advisory draft on
the repository's Security tab.

Include:

- the affected command/version and how to reproduce,
- the impact (what an attacker could do),
- any fix suggestion.

## Design boundaries

dsh-ops runs with the privileges of the user who launches it and reads and
writes their own dsh home. Trust and risk model:

- **No remote code execution**: scan/gate run local static analysis; pnpm is
  invoked with fixed argument lists; nothing fetched from the network executes
  (registry metadata is advisory only).
- **Write whitelist**: fix operations are limited to lockfile realignment and
  disabled-row writes through the profile user patch layer, always with a
  backup and a plan/confirm step. The panel API rejects cross-origin requests
  and protects official bundle rows from disable.
- **Local panel only**: `dsh-ops serve` binds 127.0.0.1 by default. Binding to
  another host exposes the read-only scan API and whitelisted writes to your
  network — do not expose it.
- **Fault injection in tests** intentionally mutates installed package trees;
  the sandbox scripts assert all mutations stay inside a temp directory.
