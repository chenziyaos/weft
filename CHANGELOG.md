# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The web app
(`package.json`, 0.2.0) and the CLI package (`cli/package.json`, `weft-canvas`
0.4.5) carry separate version numbers.

## [Unreleased]

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

- The CLI package is named `weft-canvas` and installs from a locally built
  tarball; it is not published to a registry.
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
