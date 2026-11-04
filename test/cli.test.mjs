import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURES, BIN, startRegistry, deadUrl, makeTree, run } from './helpers.mjs';

const HOME = path.join(FIXTURES, 'home');
const PROJECT = path.join(FIXTURES, 'project');
let reg;
before(async () => {
  reg = await startRegistry();
});
after(() => reg.close());

const base = () => ['--home', HOME, '--project', PROJECT, '--npm-registry', reg.url, '--pypi-url', reg.url];

test('full fixture run: statuses for every server (--json)', async () => {
  const { code, stdout, stderr } = await run([...base(), '--json']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const out = JSON.parse(stdout);
  const byName = Object.fromEntries(out.servers.map((s) => [s.server, [s.client, s.package, s.current, s.latest, s.status]]));
  assert.deepEqual(byName, {
    memory: ['claude-code', '@modelcontextprotocol/server-memory', 'latest', '2026.8.1', '@latest'],
    sentry: ['claude-code', '@sentry/mcp-server', '0.9.0', '0.20.0', 'outdated'],
    playwright: ['claude-code', '@playwright/mcp', '0.0.41', '0.0.41', 'ok'],
    filesystem: ['claude-desktop', '@modelcontextprotocol/server-filesystem', 'unpinned', '2.1.0', 'unpinned'],
    github: ['claude-desktop', 'ghcr.io/github/github-mcp-server', 'unpinned', '-', 'unpinned'],
    weather: ['claude-desktop', 'node', '-', '-', 'local'],
    context7: ['codex', '@upstash/context7-mcp', 'unpinned', '1.0.30', 'unpinned'],
    git: ['codex', 'mcp-server-git', '0.6.0', '2026.1.14', 'outdated'],
    fetch: ['cursor', 'mcp-server-fetch', 'unpinned', '2025.4.7', 'unpinned'],
    linear: ['cursor', 'https://mcp.linear.app', '-', '-', 'remote'],
    time: ['cursor', 'mcp-server-time', '2.0.0', '2.0.0', 'ok'],
    everything: ['vscode', '@modelcontextprotocol/server-everything', '^1.0.0', '1.0.0', 'unpinned'],
  });
  assert.equal(out.summary.outdated, 2);
  assert.equal(out.summary.unpinned, 5);
  assert.equal(out.configs.length, 7);
});

test('table output looks like npm outdated', async () => {
  const project = makeTree({ '.mcp.json': '{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]},"time":{"command":"uvx","args":["mcp-server-time==1.0.0"]}}}' });
  const { code, stdout } = await run(['--home', makeTree({}), '--project', project, '--npm-registry', reg.url, '--pypi-url', reg.url]);
  assert.equal(code, 0);
  assert.equal(stdout, [
    'Client       Server  Package                                  Current   Latest  Status',
    'claude-code  fs      @modelcontextprotocol/server-filesystem  unpinned  2.1.0   unpinned',
    'claude-code  time    mcp-server-time                          1.0.0     2.0.0   outdated',
    '',
    '2 servers in 1 config file: 1 outdated, 1 unpinned',
    '',
  ].join('\n'));
});

test('colors only on a TTY, and NO_COLOR / --no-color win', async () => {
  const args = [...base(), '--offline'];
  assert.match((await run(args, { isTTY: true })).stdout, /\x1b\[/);
  assert.doesNotMatch((await run(args, { isTTY: false })).stdout, /\x1b\[/);
  assert.doesNotMatch((await run(args, { isTTY: true, env: { NO_COLOR: '1' } })).stdout, /\x1b\[/);
  assert.doesNotMatch((await run([...args, '--no-color'], { isTTY: true })).stdout, /\x1b\[/);
  assert.match((await run([...args, '--color'])).stdout, /\x1b\[/);
});

test('--offline: no network requests, pinning state still reported', async () => {
  const before = reg.requests.length;
  const { code, stdout } = await run([...base(), '--offline', '--json']);
  assert.equal(code, 0);
  assert.equal(reg.requests.length, before, 'no requests in offline mode');
  const out = JSON.parse(stdout);
  const fs = out.servers.find((s) => s.server === 'filesystem');
  assert.deepEqual([fs.status, fs.latest], ['unpinned', 'offline']);
  const sentry = out.servers.find((s) => s.server === 'sentry');
  assert.deepEqual([sentry.status, sentry.latest], ['unknown', 'offline']);
});

test('no network: graceful "lookup failed" rows, exit 0', async () => {
  const dead = await deadUrl();
  const { code, stdout } = await run(['--home', HOME, '--project', PROJECT, '--npm-registry', dead, '--pypi-url', dead, '--timeout', '2000']);
  assert.equal(code, 0);
  assert.match(stdout, /@sentry\/mcp-server\s+0\.9\.0\s+lookup failed\s+unknown/);
  assert.match(stdout, /mcp-server-fetch\s+unpinned\s+lookup failed\s+unpinned/);
});

test('--ci exit codes and --fail-on', async () => {
  assert.equal((await run(base())).code, 0, 'default exit 0 even with problems');
  const ci = await run([...base(), '--ci']);
  assert.equal(ci.code, 1);
  assert.match(ci.stderr, /8 servers failed --ci \(unpinned,outdated\)/);
  assert.equal((await run([...base(), '--ci', '--fail-on', 'outdated'])).code, 1);

  const onlyUnpinned = makeTree({ '.mcp.json': '{"mcpServers":{"a":{"command":"npx","args":["-y","pkg"]}}}' });
  const args = ['--home', makeTree({}), '--project', onlyUnpinned, '--npm-registry', reg.url];
  assert.equal((await run([...args, '--ci'])).code, 1);
  assert.equal((await run([...args, '--ci', '--fail-on=outdated'])).code, 0);
  assert.equal((await run([...args, '--ci', '--fail-on', '@latest'])).code, 1);

  const clean = makeTree({ '.mcp.json': '{"mcpServers":{"a":{"command":"npx","args":["-y","pkg@3.2.1"]},"l":{"command":"node","args":["x.js"]}}}' });
  assert.equal((await run(['--home', makeTree({}), '--project', clean, '--npm-registry', reg.url, '--ci'])).code, 0);
  const offline = await run(['--home', makeTree({}), '--project', clean, '--offline', '--ci', '--fail-on', 'unknown', '--json']);
  assert.equal(offline.code, 1);
  assert.deepEqual(JSON.parse(offline.stdout).ci, { failOn: ['unknown'], failed: 1 });
});

test('secrets: env values, URL tokens and headers never appear in any output', async () => {
  const outputs = [
    await run(base()),
    await run([...base(), '--long']),
    await run([...base(), '--json']),
    await run([...base(), '--offline', '--json']),
    await run([...base(), '--dry-run']),
    await run([...base(), '--dry-run', '--json']),
  ];
  for (const o of outputs) {
    const all = o.stdout + o.stderr;
    assert.doesNotMatch(all, /SECRET/, all);
    assert.doesNotMatch(all, /sntrys_|ghp_|ctx7_/);
  }
});

test('usage errors exit 2', async () => {
  for (const args of [['--bogus'], ['--home'], ['--fail-on', 'everything'], ['--concurrency', '0'], ['--json=yes']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /mcp-outdated: /);
  }
});

test('--help and --version', async () => {
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage: mcp-outdated/);
  const v = await run(['-v']);
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('nothing found / nothing configured', async () => {
  const empty = await run(['--home', makeTree({}), '--project', makeTree({})]);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No MCP client config files found/);
  const none = await run(['--home', makeTree({ '.cursor/mcp.json': '{"mcpServers":{}}' }), '--project', makeTree({})]);
  assert.match(none.stdout, /No MCP servers configured in 1 config file/);
});

test('malformed config: warning on stderr with file:line, other configs still reported', async () => {
  const home = makeTree({ '.cursor/mcp.json': '{\n  "mcpServers": {\n    oops\n}', '.codex/config.toml': '[mcp_servers.a]\ncommand = "npx"\nargs = ["pkg@3.2.1"]\n' });
  const r = await run(['--home', home, '--project', makeTree({}), '--npm-registry', reg.url]);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /warning: ~[\\/]\.cursor[\\/]mcp\.json:3:5: cannot parse JSON/);
  assert.match(r.stdout, /codex\s+a\s+pkg\s+3\.2\.1\s+3\.2\.1\s+ok/);
});

test('the bin script runs as a real process', () => {
  const r = spawnSync(process.execPath, [BIN, '--home', HOME, '--project', PROJECT, '--offline', '--ci'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude-desktop\s+filesystem\s+@modelcontextprotocol\/server-filesystem\s+unpinned\s+offline\s+unpinned/);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
});
