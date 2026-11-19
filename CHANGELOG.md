# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The web app
(`package.json`, 0.2.0) and the CLI package (`cli/package.json`, `weft-canvas`)
carry separate version numbers; CLI releases are tagged `cli-v<version>`.

## [Unreleased]

## [cli-v0.5.0] - 2026-11-19

### Added

- `weft-canvas` is published to npm: `npm install -g weft-canvas`, or
  `npx weft-canvas serve` without a global install.
- `.github/workflows/publish-cli.yml` publishes later `cli-v*` tags to npm
  with provenance (Trusted Publishing) and to the MCP Registry.
- `weft --version` (also `-v`, `version`) prints the CLI version.

### Changed

- Dependencies updated to the newest versions within their ranges (#13, #14,
  #17); `zhipu-ai-provider` removed because it had no call sites.

## Initial public release

### Added

- First public release of this fork of
  [ThoughtDAG](https://github.com/chenxiachan/thoughtdag), with a fresh git
  history.
- `npm run cli:pack` builds the `weft-canvas` tarball from source; `npm test`
  runs the CLI unit tests plus the layout, live-log and subagent checks.
- GitHub Actions CI (lint, build, test on Node 20, 22 and 24), issue templates,
  `SECURITY.md`, `CODE_OF_CONDUCT.md` and Dependabot configuration.
- The Pages workflow also publishes a static build of the app under `/app/`,
  so `#view=` share links work without a server.

### Changed

- The CLI package is named `weft-canvas`.
- The MCP container (`cli/Dockerfile`) builds the CLI from source.
- `VERIFICATION.md` now records the acceptance scripts as run on this tree,
  with a list of what was not run.
- Agents launched from the canvas (Claude Code, Codex) run on their own login
  and model configuration.

### Removed

- Integration with a private model gateway: its provider, the single sign-on
  routes, the gateway-backed decision model and the related settings card.
- Guides, manual chapters and screenshots that depended on private services
  or showed private model catalogs.
- Git LFS tracking; media files are stored as ordinary git objects.
