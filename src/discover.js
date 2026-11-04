// Find MCP client config files and extract their server entries.
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from './jsonc.js';
import { parseToml } from './toml.js';

// Microsoft Store / MSIX installs of Claude Desktop keep their data in a
// virtualised folder: %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Claude.
// Known families: Claude_pzs8sxrjxfjjc and AnthropicPBC.Claude_fnn82j28hfe8t;
// we match any package folder whose name contains "claude".
const MSIX_FAMILY = /claude/i;

function defaultReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Candidate config files for this machine.
 * @param {{home: string, project: string, env?: object, homeOverride?: boolean,
 *          pathMod?: typeof path, platform?: string, readdir?: (dir: string) => string[]}} o
 *   pathMod/platform/readdir exist so Windows layouts can be unit-tested anywhere.
 */
export function candidates({ home, project, env = {}, homeOverride = false, pathMod = path, platform = process.platform, readdir = defaultReaddir }) {
  const P = pathMod;
  const list = [];
  const add = (client, file, format = 'json') => list.push({ client, file: P.resolve(file), format });

  add('claude-code', P.join(project, '.mcp.json'));
  add('claude-code', P.join(home, '.claude.json'));

  const desktop = [
    P.join(home, 'Library', 'Application Support', 'Claude'),
    P.join(home, 'AppData', 'Roaming', 'Claude'),
    P.join(home, '.config', 'Claude'),
  ];
  if (!homeOverride) {
    if (env.APPDATA) desktop.push(P.join(env.APPDATA, 'Claude'));
    if (env.XDG_CONFIG_HOME) desktop.push(P.join(env.XDG_CONFIG_HOME, 'Claude'));
  }
  const localAppData = [P.join(home, 'AppData', 'Local')];
  if (!homeOverride && env.LOCALAPPDATA) localAppData.push(env.LOCALAPPDATA);
  for (const lad of localAppData) {
    const pkgs = P.join(lad, 'Packages');
    for (const name of readdir(pkgs).filter((n) => MSIX_FAMILY.test(n)).sort()) {
      desktop.push(P.join(pkgs, name, 'LocalCache', 'Roaming', 'Claude'));
    }
  }
  for (const dir of desktop) add('claude-desktop', P.join(dir, 'claude_desktop_config.json'));

  add('cursor', P.join(home, '.cursor', 'mcp.json'));
  add('cursor', P.join(project, '.cursor', 'mcp.json'));
  add('vscode', P.join(project, '.vscode', 'mcp.json'));
  const codexHome = !homeOverride && env.CODEX_HOME ? env.CODEX_HOME : P.join(home, '.codex');
  add('codex', P.join(codexHome, 'config.toml'), 'toml');

  const seen = new Set();
  const fold = platform === 'win32';
  return list.filter((c) => {
    const key = fold ? c.file.toLowerCase() : c.file;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Guess client and format for an explicit --config path. */
export function classify(file) {
  const abs = path.resolve(file);
  const norm = abs.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(norm);
  const format = base.endsWith('.toml') ? 'toml' : 'json';
  let client = 'config';
  if (base === 'claude_desktop_config.json') client = 'claude-desktop';
  else if (base === '.claude.json' || base === '.mcp.json') client = 'claude-code';
  else if (norm.includes('/.cursor/')) client = 'cursor';
  else if (norm.includes('/.vscode/')) client = 'vscode';
  else if (format === 'toml' || norm.includes('/.codex/')) client = 'codex';
  return { client, file: abs, format };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function collect(out, servers, basePath, extra) {
  if (!isObj(servers)) return;
  for (const name of Object.keys(servers)) {
    if (isObj(servers[name])) out.push({ name, entry: servers[name], path: [...basePath, name], ...extra });
  }
}

/** Extract server entries from a parsed config document. */
export function extractServers(doc, format) {
  const out = [];
  if (!isObj(doc)) return out;
  if (format === 'toml') {
    collect(out, doc.mcp_servers, ['mcp_servers']);
    return out;
  }
  collect(out, doc.mcpServers, ['mcpServers']);
  collect(out, doc.servers, ['servers']);
  if (isObj(doc.mcp)) collect(out, doc.mcp.servers, ['mcp', 'servers']);
  if (isObj(doc.projects)) {
    for (const proj of Object.keys(doc.projects)) {
      const p = doc.projects[proj];
      if (isObj(p)) collect(out, p.mcpServers, ['projects', proj, 'mcpServers'], { scope: proj });
    }
  }
  return out;
}

/**
 * Read + parse one config file. Never throws.
 * @returns {{ok: boolean, missing?: boolean, text?: string, doc?: any, spans?: Map, servers?: any[], warning?: string}}
 */
export function loadConfig(cand) {
  let text;
  try {
    text = fs.readFileSync(cand.file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { ok: false, missing: true };
    return { ok: false, warning: `${cand.file}: cannot read (${e.code || e.message})` };
  }
  if (text.trim() === '') return { ok: true, text, doc: {}, spans: new Map(), servers: [] };
  try {
    const parsed = cand.format === 'toml' ? parseToml(text) : parseJsonc(text);
    return { ok: true, text, doc: parsed.value, spans: parsed.spans, servers: extractServers(parsed.value, cand.format) };
  } catch (e) {
    if (e.name === 'ParseError') return { ok: false, warning: `${cand.file}:${e.line}:${e.col}: cannot parse ${cand.format.toUpperCase()}: ${e.message}` };
    return { ok: false, warning: `${cand.file}: cannot parse: ${e.message}` };
  }
}
