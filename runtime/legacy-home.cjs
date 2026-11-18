// Data and config written under the product's previous names, moved once to
// the Weft locations. The only Node module that spells those names; the
// browser side lives in src/lib/legacy-names.ts.
//
// No require() here: the CLI bundles this file into an ES module, where a
// bundled require of a Node builtin throws. Callers pass fs/os/path in.
'use strict';

const LEGACY = ['thoughtpath', 'thoughtdag'];
const ALT = LEGACY.join('|');
const QUOTED = new RegExp(`(\\\\*")(?:${ALT})(?=[.:"\\\\-])`, 'g');
const URIS = new RegExp(`\\b(?:${ALT})(?=://|:attachment/)`, 'g');
const CANVAS_SUFFIX = new RegExp(`\\.(?:${ALT})\\.json$`, 'i');
const RULES_BLOCK = new RegExp(`\\n?<!-- (?:${ALT}):begin -->[\\s\\S]*?<!-- (?:${ALT}):end -->\\n?`, 'g');
const TOML_BLOCK = new RegExp(`(?:^#[^\\n]*\\n)?^\\[mcp_servers\\.(?:${ALT})\\]\\n(?:^(?!\\[)[^\\n]*\\S[^\\n]*(?:\\n|$))*`, 'gm');

/** Same rules as rebrandText() in src/lib/legacy-names.ts, for JSON text. */
const rebrandText = (s) => s.replace(QUOTED, '$1weft').replace(URIS, 'weft');

/** CLAUDE.md / AGENTS.md without the old marked rules block. */
const dropLegacyRules = (text) => text.replace(RULES_BLOCK, '\n').replace(/\n{3,}/g, '\n\n');

/** ~/.codex/config.toml without the old MCP server block. */
const dropLegacyMcpToml = (toml) => toml.replace(TOML_BLOCK, '').replace(/\n{3,}/g, '\n\n');

/** A .mcp.json server map without the old entries; true when one went. */
function dropLegacyMcpServers(servers) {
  let dropped = false;
  for (const old of LEGACY) if (servers && old in servers) { delete servers[old]; dropped = true; }
  return dropped;
}

function bindLegacyHome({ fs, os, path }) {
  const moveIfAbsent = (from, to) => {
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    try { fs.renameSync(from, to); return true; } catch { return false; }
  };
  const rewrite = (file, to = file) => {
    const text = fs.readFileSync(file, 'utf8');
    const next = rebrandText(text);
    if (to === file) {
      if (next !== text) fs.writeFileSync(file, next);
      return;
    }
    fs.writeFileSync(to, next, { mode: fs.statSync(file).mode & 0o777 });
    fs.unlinkSync(file);
  };

  /** <dir>/.thoughtpath (guard file, materials) → <dir>/.weft. */
  function adoptLegacyProjectDir(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return;
    for (const old of LEGACY) moveIfAbsent(path.join(dir, `.${old}`), path.join(dir, '.weft'));
  }

  let homeChecked = false;
  /** ~/.thoughtpath → ~/.weft, canvas records renamed to *.weft.json and
   *  the identifiers inside the JSON stores rewritten. An explicit WEFT_HOME
   *  is the caller's own directory and is never touched. */
  function adoptLegacyHome() {
    if (homeChecked || process.env.WEFT_HOME) return;
    homeChecked = true;
    const home = path.join(os.homedir(), '.weft');
    let moved = false;
    for (const old of LEGACY) moved = moveIfAbsent(path.join(os.homedir(), `.${old}`), home) || moved;
    try {
      if (moved) {
        for (const name of fs.readdirSync(home)) if (/\.jsonl?$/.test(name)) rewrite(path.join(home, name));
        const workspaces = path.join(home, 'workspaces');
        if (fs.existsSync(workspaces)) for (const id of fs.readdirSync(workspaces)) adoptLegacyProjectDir(path.join(workspaces, id));
      }
      const canvases = path.join(home, 'canvases');
      if (fs.existsSync(canvases)) {
        for (const name of fs.readdirSync(canvases)) {
          if (!CANVAS_SUFFIX.test(name)) continue;
          const to = path.join(canvases, name.replace(CANVAS_SUFFIX, '.weft.json'));
          if (!fs.existsSync(to)) rewrite(path.join(canvases, name), to);
        }
      }
    } catch (err) {
      console.warn('[weft] legacy data migration incomplete:', err.message);
    }
  }

  /** The handoff commands installed into the agents' own directories under
   *  the old name move to the new one, where the status check offers an
   *  update; an existing new install wins. */
  function adoptLegacyCommands() {
    for (const old of LEGACY) {
      moveIfAbsent(path.join(os.homedir(), '.claude', 'commands', `${old}.md`), path.join(os.homedir(), '.claude', 'commands', 'weft.md'));
      moveIfAbsent(path.join(os.homedir(), '.codex', 'skills', old), path.join(os.homedir(), '.codex', 'skills', 'weft'));
    }
  }

  /** The desktop profile (IndexedDB, localStorage, preferences) kept under
   *  the old app name moves to the new one before Electron opens it. */
  function adoptLegacyProfile(appData, dataDir, packaged) {
    moveIfAbsent(path.join(appData, packaged ? 'ThoughtPath' : 'thoughtpath-desktop'), dataDir);
  }

  return { adoptLegacyHome, adoptLegacyProjectDir, adoptLegacyCommands, adoptLegacyProfile };
}

module.exports = { bindLegacyHome, rebrandText, dropLegacyRules, dropLegacyMcpToml, dropLegacyMcpServers };
