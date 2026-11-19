#!/usr/bin/env node
// Copy everything the published CLI package carries beyond dist/weft.mjs into
// cli/: the host Skill with its installer, the /weft and $weft commands, and the canvas app for `weft serve`
// (the bundled server, the built frontend, the runtime it requires at run time
// and pdfjs's worker, which the bundle loads from its own directory).
// Prerequisites: npm run build, cli:build, host:build, serve:build.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli');
const need = ['dist/index.html', 'host-dist/weft.mjs', 'host-dist/host-handoff.mjs', 'cli/app/server.mjs'];
for (const file of need) {
  if (!existsSync(path.join(root, file))) { console.error(`missing ${file}: run the CLI package build first`); process.exit(1); }
}
const copy = (from, to, opts) => { mkdirSync(path.dirname(path.join(cli, to)), { recursive: true }); cpSync(path.join(root, from), path.join(cli, to), opts); };

rmSync(path.join(cli, 'skill'), { recursive: true, force: true });
rmSync(path.join(cli, 'host-dist'), { recursive: true, force: true });
rmSync(path.join(cli, 'scripts'), { recursive: true, force: true });
rmSync(path.join(cli, 'commands'), { recursive: true, force: true });
copy('skill/weft-canvas/SKILL.md', 'skill/weft-canvas/SKILL.md');
copy('host-dist/host-handoff.mjs', 'host-dist/host-handoff.mjs');
copy('host-dist/weft.mjs', 'host-dist/weft.mjs');
copy('scripts/install-skill.mjs', 'scripts/install-skill.mjs');
copy('protocol/adapters/claude-code/weft.md', 'commands/claude-code-weft.md');
copy('protocol/adapters/codex/skills/weft/SKILL.md', 'commands/codex-weft-SKILL.md');

// Deployment-only files of the hosted site stay out of the local app.
const HOSTED_ONLY = new Set(['_headers', 'robots.txt', 'sitemap.xml']);
rmSync(path.join(cli, 'app/dist'), { recursive: true, force: true });
rmSync(path.join(cli, 'app/runtime'), { recursive: true, force: true });
copy('dist', 'app/dist', { recursive: true, filter: (src) => !HOSTED_ONLY.has(path.relative(path.join(root, 'dist'), src)) && !src.endsWith('.map') });
copy('runtime', 'app/runtime', { recursive: true, filter: (src) => !src.endsWith('README.md') });
// the minified build under the name the bundled server resolves
copy('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'app/pdf.worker.mjs');
copy('.env.example', 'app/env.example');
console.log('staged host skill, agent commands and canvas app into cli/');
