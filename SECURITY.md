# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Do NOT create a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/entire-vc/evc-team-relay-obsidian/security/advisories/new)**

The report is visible only to the maintainers of this repository until we publish an advisory. If
you cannot use GitHub, email <support@entire.vc> with `SECURITY` in the subject and we will move the
conversation somewhere private; do not put vulnerability details in a public issue in the meantime.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

1. **Acknowledgment** — We'll respond within 48 hours
2. **Assessment** — We'll investigate and assess severity
3. **Fix** — We'll develop and test a fix
4. **Disclosure** — We'll coordinate disclosure timing with you
5. **Credit** — We'll credit you in the release notes (if desired)

### Timeline

- Critical vulnerabilities: Fix within 7 days
- High severity: Fix within 14 days
- Medium/Low: Fix in next release cycle

## Scope

This plugin connects to a self-hosted or EVC-operated Team Relay server for real-time collaboration. Security concerns are primarily related to:
- Authentication and token handling (JWT / CWT)
- WebSocket connection security
- Yjs CRDT document sync and access control
- Safe handling of shared workspace data

In scope:
- This plugin's code
- Its interaction with the Team Relay control plane / relay server

Out of scope:
- The relay server itself, whose sources live in `apps/relay-server/` of the Team Relay repository (report at [entire-vc/evc-team-relay](https://github.com/entire-vc/evc-team-relay/security/advisories/new))
- Third-party integrations
- User-modified deployments
- Social engineering attacks
- Physical attacks

## Hall of Fame

We thank the following security researchers for responsible disclosure:

*No submissions yet*

---

Thank you for helping keep EVC Team Relay secure!
