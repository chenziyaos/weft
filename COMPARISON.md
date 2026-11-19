# Weft and similar tools

[中文](./COMPARISON_ZH.md)

Of the four tools below, three search or show your local coding-agent history;
Weft also lets you change what the next model turn reads. The comparison uses
only what each project states in its own README as of 2026-11-19. Nothing here
was benchmarked.
If an entry is out of date, please open an issue or a pull request.

## The short version

- **Weft** answers "which turns touched this file, and what did they say?" and
  lets you edit what the next model turn reads, on a canvas.
- **[episodic-memory](https://github.com/obra/episodic-memory)** gives an agent
  semantic recall over past conversations.
- **[claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp)**
  searches Claude Code history through MCP and keeps no index on disk.
- **[claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer)**
  is a desktop app and web server for browsing and analysing history from
  many assistants.

## Side by side

| | Weft | episodic-memory | claude-historian-mcp | claude-code-history-viewer |
|---|---|---|---|---|
| Main job | Find the turns behind a file or phrase; edit the context of the next turn on a canvas | Semantic recall for agents | Search and summarise history through MCP | Browse, search and analyse history |
| Sources it reads | Claude Code, Codex, DeepSeek Harness, Pi, Weft canvases | Claude Code, Codex, Cursor, opencode, Oh My Pi | Claude Code session JSONL | 31 assistants, per its README |
| How it searches | Anchored lookups (file path, URL, arXiv id) and exact, case-insensitive phrases | Semantic search | Fuzzy matching and query expansion; its README lists 12 algorithms | Search in the app |
| Writes to disk | Derived index under `~/.weft`; source logs are never rewritten | Index built at the end of each session | Nothing, per its README | Not covered here |
| Agent interface | Read-only MCP server (4 tools), `/weft` and `$weft`, a canvas Skill | MCP server, Claude Code and Codex plugins | MCP server | None; a viewer for people |
| Changes what a model reads next | Yes: cut, rewire or archive context on the canvas | No | No | No |

## Which one to pick

- **Pick episodic-memory** when you want an agent to recall past discussions by
  meaning, not by exact words.
- **Pick claude-historian-mcp** when you want history search with no install
  step and nothing stored on disk.
- **Pick claude-code-history-viewer** when you mainly want to read and analyse
  sessions from many different assistants in one window.
- **Pick Weft** when you want to answer "why does this file look like this?"
  from the turns that edited it, or when you want to decide on a canvas exactly
  which earlier turns the next request carries.

The tools can run side by side: each one only reads the session files.

## Limits of this comparison

- The columns for the other tools come from their READMEs, not from running
  them.
- "Exact" for Weft's `find` means no stemming, synonyms or embeddings. A
  paraphrase will not match.
- Weft's MCP server cannot edit a canvas. Editing goes through the canvas Skill
  and the live bridge, which the user turns on per canvas.
