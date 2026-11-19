# Acceptance record and verification boundaries

This file records which acceptance scripts were run against this repository,
what each result covers and what it does **not** establish. For what the
features do, see [README.md](README.md).

[中文](VERIFICATION_ZH.md)

## Environment

| Item | Value |
|---|---|
| Date | 2026-11-18 |
| Tree | this repository before its first public commit |
| OS | macOS 15.6.1 (Apple silicon) |
| Node.js | v26.7.0 (the CLI targets Node 20 or newer) |
| Browser | local Google Chrome, driven by Playwright |
| Dependencies | `npm ci` from the public npm registry |
| Models | none; no script below called a model |

The scripts write their evidence (summary JSON, screenshots) into `evidence*/`
directories, which are ignored by git. Rerun a script to regenerate its
evidence; the counts below are what those runs printed.

## Build and unit checks

| Command | Result |
|---|---|
| `npm run build` (typecheck + production build) | Pass |
| `npm run lint` | Pass |
| `npm --prefix cli test` | Pass: 95/95 |
| `npm run test:layout` · `test:live-log` · `test:subagents` | Pass |
| `npm run website:build` then `npm run website:check` | Pass |

## Acceptance scripts

Each script drives the built product through its public surface: the real
local proxy, the built page in Chrome, or the CLI as a subprocess. None of them
imports product internals to fake a result. Answers that appear in these runs
are synthetic unless the row says otherwise.

| Script | What it checks | Result |
|---|---|---|
| `verify-cli-package.mjs <tgz>` | Install the `weft-canvas` tarball into an empty project; `weft serve`; open the canvas; upload a PDF; `weft setup skill`; an agent edits the live canvas; second start; port conflict; Ctrl+C | Pass: 12/12 |
| `verify-install-release.mjs` | Fresh install through 20 public Node commands; 12 installed Skill files match manifest sizes and SHA-256; dry run leaves the project unchanged; a repeat install is refused | Pass: 53/53 |
| `verify-byo.mjs` | No key and no model configured: the proxy starts empty, an OpenAI-compatible endpoint added in the dialog lists its models, a self-hosted `/v1/systemone` endpoint becomes the decision model and ranks a two-model fan-out (local stand-in endpoints) | Pass: 9/9 |
| `verify-context-visible.mjs` | The follow-up preview equals, message for message, what the page sends and what the proxy forwards; each answer version keeps its request; rows changed since are marked; drag-to-reconnect refuses cycles; insert and delete a middle step | Pass: 35/35 |
| `verify-replay-plan.mjs` | One-click replay runs stale nodes in dependency order, skips nodes whose input did not change, stops below a failed node and retries it | Pass: 13/13 |
| `verify-tool-outputs.mjs` | Earlier tool outputs stay out of a follow-up by default; the attachments panel marks them and brings one back on click; large requests show a warning | Pass: 9/9 |
| `verify-local-atlas.mjs` | `weft setup skill` installs `/weft` and `$weft`; `weft open` starts a background server and opens a Claude Code session; a turn appended to the session file reaches the canvas; `weft stop` ends the server | Pass: 17/17 |
| `verify-canvas-bridge.mjs` | Live canvas bridge: token file mode, unauthorized and foreign-origin rejection, branch and reference edits, idempotent replay, revision conflict, undo, writeback, off after reload | Pass: 27/27 |
| `verify-multi-agent.mjs` | Two hosts edit one canvas from the same revision: exactly one wins, the other gets `REVISION_CONFLICT`; sibling branches stay blind; stale downstream answers are queued | Pass: 16/16 |
| `verify-workspace-cli.mjs` | Public workspace CLI, graph-only and unified entries, size and shape limits | Pass: 308/308 |
| `verify-workspace-ui.mjs` | Workspace round trip in the built UI: reload, duplicate import, conflict rejection, cross-tab saves | Pass: 36/36 |
| `verify-hydration-ui.mjs` | Project hydration with delayed reads and injected IndexedDB read failures; stored data is never replaced by an empty project | Pass: 13/13 |

`verify-hydration-ui.mjs` passing means the data-protection checks passed, not
that the page had no errors: injected failures reach callers that do not all
catch them, so the run records expected `pageerror` events.

## Scripts not run for this record

| Script | Why it was not run |
|---|---|
| `verify-real-host.mjs` | Needs Claude Code and Codex signed in with model access; see the script header for `WEFT_E2E_CLAUDE_MODEL` / `WEFT_E2E_CODEX_MODEL` |
| `e2e-user-journey.mjs` | Needs at least three live models configured in the proxy and Codex signed in |
| `test-memory-judge.mjs` | Needs a live judge model |
| `npm run smoke` | Calls a configured model |

## Verification boundaries

The following is **not** established by the runs above and must not be read as
verified:

- **No live models.** Every answer in these runs is synthetic or comes from a
  local stand-in endpoint. Answer quality, provider compatibility and the
  decision model's calibration were not measured.
- **No real hosts.** Claude Code and Codex discovering and running the
  installed Skill were not exercised in this record. `host`, `runId` and
  `executionMode` in a bundle are declarations by the caller, not evidence.
- **No isolation verification.** Previous-session isolation, ambient memory
  exclusion and execution boundaries are the host's responsibility.
  `isolationVerified` is always `false` by design.
- **Two platforms.** The table above is a macOS run with local Chrome. Since
  2026-11-19, `.github/workflows/acceptance.yml` also runs the twelve scripts
  in the table nightly on Linux (ubuntu-latest, Node 22, the runner's Google
  Chrome). Windows, mobile browsers and Node 20 are not run with these
  scripts; CI runs build, lint and unit tests on Node 20, 22 and 24.
- **Limits not stress-tested.** `verify-workspace-cli` rejects a file one byte
  over 32 MiB and an edit with 501 operations. The node, edge and depth limits
  (500 nodes, 4,000 edges, depth 128) and behavior near any limit at scale were
  not measured.
- **Fingerprints cover graph-compiled input**, not provider-side state or the
  agent runtime's own system prompt. A hash detects drift; it does not
  authenticate authorship.
- **Scoped persistence protection.** Ordinary graph saves use compare-and-set
  and workspace sync checks the stored envelope. Cross-tab project metadata
  changes, deletion, migration, real disk failure and quota recovery are
  outside this promise. For a save conflict, export unsaved edits **before**
  refreshing.
- **Handoffs embed the complete graph snapshot**, which may contain nodes
  outside the selected context; inspect before sharing.
- **Surfaces without a script.** The desktop shell, the DeepSeek Harness
  plugin (`dsh/`), the Remotion video and the benchmark tools were built or
  kept as source but have no acceptance run here.
