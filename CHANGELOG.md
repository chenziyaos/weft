# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The web app
(`package.json`, 0.2.0) and the CLI package (`cli/package.json`, `weft-canvas`)
carry separate version numbers; CLI releases are tagged `cli-v<version>`.

## [Unreleased]

## [cli-v0.5.1] - 2026-11-19

### Added

- Claude Code and Codex plugin (`plugins/weft`, listed in
  `.claude-plugin/marketplace.json`): the `/weft` command, the `weft-canvas`
  Skill and the read-only MCP server through `npx weft-canvas mcp`.
  `npm run plugin:build` regenerates it; CI fails when it is out of date.

### Changed

- When no `weft` command is installed, `/weft` and `$weft` fall back to
  `npx -y weft-canvas` and suggest `npm install -g weft-canvas`, instead of
  pointing at a source install.
- The npm package is smaller: three unreferenced cover images (4.8 MB) are
  gone from the bundled app, the bundled server is whitespace- and
  syntax-minified, and the PDF worker is pdfjs's minified build.

### Fixed

- The website download block, the Pages build and the desktop update notice
  read only desktop releases (`v<version>` tags); a `cli-v*` release no longer
  shows up as a desktop version. CLI releases are created without the
  "Latest" mark.

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
