# Security Policy

## Credential Storage

GitHub personal access tokens (PATs) are encrypted with **AES-256-CBC** using:

- A **random salt** generated per credential
- A **machine-derived key** constructed from `hostname + username`

Encrypted credentials are stored in `~/.rewind/credentials.json` with file mode `0600` (owner read/write only).

### Limitations

The encryption key is derived from machine identifiers that are not secrets. This protects against casual inspection and cross-machine credential theft, but **not** against a determined attacker with local access to the same user account. Credential file security ultimately depends on filesystem permissions.

## Token Handling

Tokens are **never** embedded in git remote URLs. Authentication is injected per-command via git credential helpers and is not persisted to disk outside the encrypted credential file.

## Process Spawning

Git commands are executed via `child_process.execFile` (not `exec`), which avoids shell injection by passing arguments as an array rather than concatenating a shell command string.

The git executable path defaults to `git` resolved from PATH. It can be overridden via the `gitPath` configuration option.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.1.x   | Yes       |
| < 1.1   | No        |

## Reporting Vulnerabilities

Please report security issues by opening a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories) on this repository, or by contacting the maintainers directly.

**Do not open public issues for security vulnerabilities.**

We will acknowledge reports within 72 hours and aim to release a fix within 14 days for critical issues.
