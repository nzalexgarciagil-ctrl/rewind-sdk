# Contributing to Rewind SDK

Thank you for your interest in contributing. This guide covers everything you need to get started.

## Architecture Overview

The SDK uses a **factory/DI pattern**. Each module in `core/` exports an IIFE that returns `{ create: function(deps) { ... } }`. The entry point `rewind.js` wires modules together by passing dependencies during creation.

The host script `rewind-host.jsx` is **ES3 ExtendScript** and runs in Adobe's ExtendScript engine, separate from the CEP panel's Chromium runtime.

### Module Dependency Graph

```
rewind.js (entry point / facade)
  -> core/bridge.js (CSInterface wrapper)
  -> core/git-manager.js (child_process.execFile)
  -> core/github-manager.js (depends on git-manager)
  -> core/prproj-handler.js (gzip/gunzip)
  -> core/diff-engine.js (XML comparison)
  -> core/version-controller.js (orchestrator, depends on all above)
ui/rewind-ui.js (optional mountable UI widget)
host/rewind-host.jsx (ExtendScript backend, ES3)
```

`version-controller.js` is the orchestrator — it depends on every other core module. `github-manager.js` depends on `git-manager.js` for executing git commands. All other core modules are independent of each other.

## Code Style

- **ES5 JavaScript** for all panel-side code (`rewind.js`, `core/`, `ui/`). The CEP Chromium runtime does not reliably support ES6+.
- **ES3** for `host/rewind-host.jsx`. Adobe's ExtendScript engine is ES3-only.
- **No npm dependencies.** The SDK must work when copied into any CEP extension without `npm install`.
- **CSS class prefix:** All UI widget classes use the `.rw-` prefix to avoid collisions with host extension styles.

## Version Sync

When bumping the version, update all three locations:

1. `package.json` — the `version` field
2. `rewind.js` — the `version` property in the SDK facade
3. `core/github-manager.js` — the `User-Agent` header string

All three must match.

## Building

Run the build script from the `sdk/` directory:

```bash
node build.js
```

This generates bundled files in `dist/`. Always rebuild before committing changes to ensure the dist files are up to date.

## Testing

There are no automated tests yet — contributions to add a test suite are welcome.

Manual testing requires:

1. A CEP extension running inside Adobe Premiere Pro
2. CEP debug mode enabled (`PlayerDebugMode` set to `1`)
3. Git installed and available in PATH

To test changes, copy the modified SDK into a CEP extension, reload the panel, and exercise the affected functionality.

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `master`
3. Make your changes
4. Run `node build.js` and include the updated `dist/` files
5. Test manually in a CEP extension if possible
6. Submit a pull request with a clear description of what changed and why

Keep PRs focused on a single concern. If you are fixing a bug and also want to refactor something, submit them as separate PRs.

## Relationship to the Rewind Extension

This SDK shares heritage with the standalone [Rewind](https://github.com/nzalexgarciagil-ctrl/rewind) extension but is an **independent project**. The two are not coupled — changes to one do not require changes to the other. The SDK is designed to be embedded in any CEP extension, while Rewind is a standalone panel.

## Questions?

Open an issue on GitHub if you have questions or want to discuss a contribution before starting work.
