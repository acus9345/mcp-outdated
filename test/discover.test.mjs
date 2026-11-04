import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FIXTURES, makeTree } from './helpers.mjs';
import { candidates, classify } from '../src/discover.js';
import { loadAll, makeRows } from '../src/check.js';

const HOME = path.join(FIXTURES, 'home');
const PROJECT = path.join(FIXTURES, 'project');

const servers = (opts) => {
  const { configs, warnings } = loadAll({ env: {}, ...opts });
  return { warnings, list: makeRows(configs).map((r) => `${r.client}:${r.server}`).sort(), configs };
};

test('discovers every client config in a fixture home + project', () => {
  const { list, warnings, configs } = servers({ home: HOME, project: PROJECT });
  assert.deepEqual(warnings, []);
  assert.deepEqual(list, [
    'claude-code:memory',
    'claude-code:playwright',
    'claude-code:sentry',
    'claude-desktop:filesystem',
    'claude-desktop:github',
    'claude-desktop:weather',
    'codex:context7',
    'codex:git',
    'cursor:fetch',
    'cursor:linear',
    'cursor:time',
    'vscode:everything',
  ].sort());
  assert.equal(configs.length, 7);
});

test('~/.claude.json: top-level and per-project mcpServers', () => {
  const { configs } = loadAll({ home: HOME, project: makeTree({}), env: {} });
  const rows = makeRows(configs).filter((r) => r.file.endsWith('.claude.json'));
  assert.deepEqual(rows.map((r) => [r.server, r.scope]), [['memory', null], ['sentry', '/work/app']]);
});

for (const [label, rel] of [
  ['macOS', 'Library/Application Support/Claude/claude_desktop_config.json'],
  ['Windows', 'AppData/Roaming/Claude/claude_desktop_config.json'],
  ['Linux', '.config/Claude/claude_desktop_config.json'],
]) {
  test(`Claude Desktop config location: ${label}`, () => {
    const home = makeTree({ [rel]: '{"mcpServers":{"x":{"command":"npx","args":["-y","pkg"]}}}' });
    assert.deepEqual(servers({ home, project: makeTree({}) }).list, ['claude-desktop:x']);
  });
}

test('Claude Desktop via %APPDATA% when no --home override', () => {
  const appdata = makeTree({ 'Claude/claude_desktop_config.json': '{"mcpServers":{"w":{"command":"uvx","args":["p"]}}}' });
  const list = candidates({ home: makeTree({}), project: makeTree({}), env: { APPDATA: appdata } });
  assert.ok(list.some((c) => c.file === path.join(appdata, 'Claude', 'claude_desktop_config.json')));
  const withOverride = candidates({ home: makeTree({}), project: makeTree({}), env: { APPDATA: appdata }, homeOverride: true });
  assert.ok(!withOverride.some((c) => c.file.startsWith(appdata)));
});

test('Cursor global + project, VS Code "servers" key, Codex TOML', () => {
  const home = makeTree({
    '.cursor/mcp.json': '{"mcpServers":{"g":{"command":"npx","args":["a"]}}}',
    '.codex/config.toml': '[mcp_servers.c]\ncommand = "npx"\nargs = ["b"]\n',
  });
  const project = makeTree({
    '.cursor/mcp.json': '{"mcpServers":{"p":{"command":"npx","args":["c"]}}}',
    '.vscode/mcp.json': '// hi\n{"servers":{"v":{"type":"stdio","command":"npx","args":["d"]}}}',
  });
  assert.deepEqual(servers({ home, project }).list, ['codex:c', 'cursor:g', 'cursor:p', 'vscode:v']);
});

test('--config scans only the given files and classifies them', () => {
  const file = path.join(HOME, '.codex', 'config.toml');
  const { list } = servers({ configs: [file], home: makeTree({}) });
  assert.deepEqual(list, ['codex:context7', 'codex:git']);
  assert.equal(classify('/x/.vscode/mcp.json').client, 'vscode');
  assert.equal(classify('/x/claude_desktop_config.json').client, 'claude-desktop');
  assert.equal(classify('/x/whatever.json').client, 'config');
  assert.equal(classify('/x/settings.toml').format, 'toml');
});

test('--config with a missing file warns instead of crashing', () => {
  const { warnings, list } = servers({ configs: [path.join(FIXTURES, 'nope.json')] });
  assert.deepEqual(list, []);
  assert.match(warnings[0], /nope\.json: not found/);
});

test('malformed JSON and TOML produce file:line warnings and are skipped', () => {
  const broken = path.join(FIXTURES, 'broken');
  const { warnings, list } = servers({ home: broken, project: makeTree({}) });
  assert.deepEqual(list, []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /[\\/]\.cursor[\\/]mcp\.json:\d+:\d+: cannot parse JSON/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /config\.toml:4:\d+: cannot parse TOML/.test(w)), warnings.join('\n'));
});

test('empty files, wrong shapes and non-object entries are tolerated', () => {
  const home = makeTree({
    '.cursor/mcp.json': '',
    '.claude.json': '{"mcpServers": [1,2], "projects": {"/a": null, "/b": {"mcpServers": {"ok": {"command":"npx","args":["p"]}, "bad": "str"}}}}',
    '.codex/config.toml': 'mcp_servers = 5\n',
  });
  const { warnings, list } = servers({ home, project: makeTree({}) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(list, ['claude-code:ok']);
});

test('a directory where a config file should be is reported, not fatal', () => {
  const home = makeTree({ '.cursor/mcp.json/inner': 'x' });
  const { warnings } = servers({ home, project: makeTree({}) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot read/);
});
