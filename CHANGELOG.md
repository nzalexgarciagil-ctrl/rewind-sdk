# Changelog

## [1.1.0] - 2026-04-07

### Security
- GitHub tokens are no longer embedded in git remote URLs; auth uses per-command credential helpers
- Token encryption uses random salt instead of hardcoded value
- Removed insecure base64 fallback for token storage
- Credential files written with restrictive permissions (0600)

### Fixed
- Replaced `prompt()` calls with custom modals (CEP-compatible)
- File-lock handling uses polling instead of hardcoded delays
- SDK example paths now reference realistic CSInterface.js location
- User-Agent string matches SDK version (was `rewind-sdk/1.0`, now `rewind-sdk/1.1.0`)

### Added
- Pre-built `dist/` bundles included in repository
- CONTRIBUTING.md, SECURITY.md, CHANGELOG.md
- SDK-specific ESLint config with `no-alert` rule

### Changed
- Build script reads version from local package.json
- `setupRemote()` no longer accepts a token parameter (auth is internal)
