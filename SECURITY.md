# Security policy

## Supported versions

Only the latest commit on `main` receives fixes. There are no maintained
release branches.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: **Security → Report a vulnerability** on
<https://github.com/chenziyaos/weft/security/advisories/new>.

Include what you found, how to reproduce it, and what an attacker could do with
it. You should get a first reply within 7 days. This is a personal project, so
there is no bug bounty and no guaranteed fix time.

## Scope

In scope:

- the local proxy (`server.mjs`) and the routes it exposes on `localhost`;
- the live canvas bridge (token handling, origin checks, revision checks);
- the `weft` CLI, the Skill installer and the files they write;
- the desktop shell in `desktop/`.

Out of scope:

- model providers, Claude Code, Codex and other hosts Weft talks to;
- a deployment you run yourself with a configuration that differs from the
  defaults (for example, binding the proxy to a public interface).

## Handling secrets

Provider keys entered in the browser stay in that browser's localStorage and in
the proxy's memory; keys in `.env` stay on your machine. Never paste a key into
an issue, a pull request or a shared canvas export.
