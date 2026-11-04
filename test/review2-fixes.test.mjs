// Regression tests for review round 2: N1-N5 and items 7, 8, 11, 12.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRegistry, makeTree, run } from './helpers.mjs';
import { resolveServer } from '../src/resolve.js';
import { loadAll, makeRows, applyLookups } from '../src/check.js';
import { pinConfigs, isReadOnly } from '../src/pin.js';
import { redactArgs, isSecretPath } from '../src/redact.js';

let reg;
before(async () => { reg = await startRegistry(); });
after(() => reg.close());

const noFiles = { exists: () => false };
const base = (h) => ['--home', h, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--no-color'];
const read = (f) => fs.readFileSync(f, 'utf8');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function planned(home) {
  const loaded = loadAll({ home, project: makeTree({}), env: {} });
  const rows = makeRows(loaded.configs);
  await applyLookups(rows, { npmRegistry: reg.url, pypiUrl: reg.url, timeout: 2000 });
  return { configs: loaded.configs, rows };
}

// ---- N1 / N2: the review's exact repro cases --------------------------------

const LEAKS = {
  oldbehaviour: { command: 'C:\\tools\\server.exe --api-key sk-SECRET3' },
  spaced: { command: 'C:\\Program Files\\My Server\\server.exe --api-key sk-SECRET1' },
  cmdone: { command: 'cmd', args: ['/c', 'npx -y pkg --token ghp_SECRET2'] },
  cmdplain: { command: 'cmd', args: ['/c', 'npx -y pkg --token plainSECRET5'] },
  posix: { command: '/usr/local/bin/my-mcp --api-key sk-SECRET4' },
  n2: { command: 'npx -y pkg --api-key sk-SECRET9' },
};

test('N1/N2: review repros leak nothing in table, --json, --ci, --dry-run (default and --show-args)', async () => {
  const h = makeTree({ '.cursor/mcp.json': JSON.stringify({ mcpServers: LEAKS }, null, 2) + '\n' });
  for (const extra of [[], ['--json'], ['--ci'], ['--dry-run'], ['--show-args'], ['--json', '--show-args'], ['--dry-run', '--show-args']]) {
    const r = await run([...base(h), ...extra]);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET\d/i, `leak with ${extra.join(' ') || 'defaults'}:\n${r.stdout}${r.stderr}`);
  }
  const j = JSON.parse((await run([...base(h), '--json'])).stdout);
  const by = Object.fromEntries(j.servers.map((s) => [s.server, s]));
  assert.equal(by.oldbehaviour.package, 'server');
  assert.equal(by.spaced.package, 'server');
  assert.equal(by.posix.package, 'my-mcp');
  assert.equal(by.cmdone.package, 'pkg');
  assert.equal(by.n2.package, 'pkg');
});

test('N1: a local row never shows anything after the executable name', () => {
  for (const command of ['/usr/local/bin/my-mcp --api-key sk-x', 'C:\\tools\\server.exe --api-key sk-x', 'my-mcp --api-key sk-x', 'C:\\Weird Dir\\tool --password pw']) {
    const r = resolveServer({ command }, noFiles);
    assert.equal(r.kind, 'local', command);
    assert.doesNotMatch(r.display || r.launcher, /\s|api|sk-|pw/, `${command} -> ${r.display}`);
  }
  // single cmd /c string that is not a runner: still only the executable name
  const r = resolveServer({ command: 'cmd', args: ['/c', 'my-mcp.exe --api-key sk-x'] }, noFiles);
  assert.equal(r.kind, 'local');
  assert.doesNotMatch(r.display || r.launcher, /\s|sk-/);
});

// ---- item 7: cmd switches and the one-argument form --------------------------

test('#7: cmd /s /c, /d /c, /q /e:on /c and cmd /c "npx -y pkg" unwrap to the runner', () => {
  const cases = [
    { command: 'cmd', args: ['/s', '/c', 'npx', '-y', 'pkg'] },
    { command: 'cmd', args: ['/d', '/c', 'npx', '-y', 'pkg'] },
    { command: 'cmd.exe', args: ['/D', '/Q', '/E:ON', '/C', 'npx', '-y', 'pkg'] },
    { command: 'cmd', args: ['/c', 'npx -y pkg'] },
    { command: 'cmd', args: ['/s', '/c', 'npx -y pkg'] },
    { command: 'cmd /s /c npx -y pkg' },
    { command: 'cmd', args: ['/c', 'uvx mcp-server-fetch'] },
  ];
  for (const entry of cases) {
    const r = resolveServer(entry, noFiles);
    assert.ok(r.kind === 'package' && (r.ecosystem === 'npm' || r.ecosystem === 'pypi'), `${JSON.stringify(entry)} -> ${JSON.stringify(r)}`);
    assert.ok(r.name === 'pkg' || r.name === 'mcp-server-fetch');
  }
  assert.equal(resolveServer({ command: 'cmd', args: ['/c'] }, noFiles).kind, 'unknown');
  assert.equal(resolveServer({ command: 'cmd', args: ['/s'] }, noFiles).kind, 'local');
});

test('#7: --pin rewrites the package inside a cmd /c "..." argument, nothing else', async () => {
  const input = '{\n  "mcpServers": {\n    "a": {"command": "cmd", "args": ["/c", "npx -y pkg --token ghp_KEEPaaaaaaaaaaaaaaaaaaaa"]},\n    "b": {"command": "cmd", "args": ["/s", "/c", "npx -y \\"pkg\\""]}\n  }\n}\n';
  const h = makeTree({ '.cursor/mcp.json': input });
  const file = path.join(h, '.cursor/mcp.json');
  const r = await run([...base(h), '--pin']);
  assert.equal(r.code, 0);
  assert.equal(read(file), input.replace('npx -y pkg --token', 'npx -y pkg@3.2.1 --token').replace('npx -y \\"pkg\\"', 'npx -y \\"pkg@3.2.1\\"'));
  assert.doesNotMatch(r.stdout + r.stderr, /KEEP/);
  assert.match(read(file), /ghp_KEEPaaaaaaaaaaaaaaaaaaaa/, 'secret byte-exact in the file');
});

// ---- item 8: --ci --pin judges the post-pin state ----------------------------

const UNPINNED = '{\n  "mcpServers": {\n    "a": {"command": "npx", "args": ["-y", "pkg"]}\n  }\n}\n';

test('#8: --ci --pin exits 0 after a successful pin; --dry-run still exits 1', async () => {
  const h = makeTree({ '.cursor/mcp.json': UNPINNED });
  const dry = await run([...base(h), '--ci', '--pin', '--dry-run']);
  assert.equal(dry.code, 1, 'dry run judges the file as it is');
  const real = await run([...base(h), '--ci', '--pin', '--json']);
  assert.equal(real.code, 0, real.stderr);
  const row = JSON.parse(real.stdout).servers[0];
  assert.equal(row.status, 'ok');
  assert.equal(row.current, '3.2.1');
  // and the next plain --ci run agrees
  assert.equal((await run([...base(h), '--ci'])).code, 0);
});

test('#8: --ci --pin still fails when the write fails', async () => {
  const h = makeTree({ '.cursor/mcp.json': UNPINNED });
  const file = path.join(h, '.cursor/mcp.json');
  fs.chmodSync(file, 0o444);
  try {
    const r = await run([...base(h), '--ci', '--pin']);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /file is read-only/);
  } finally { fs.chmodSync(file, 0o644); }
});

// ---- item 12: auth vs author ---------------------------------------------------

test('#12: auth matches auth/auth-token/authorization/oauth, never author/authority', () => {
  assert.deepEqual(
    redactArgs(['--author', 'Jane', '--authors', 'A,B', '--authority', 'x.example', '--auth', 's1', '--auth-token', 's2', '--authorization', 's3', '--oauth', 's4', '--x-auth-key', 's5', '--AUTH_TOKEN', 's6']),
    ['--author', 'Jane', '--authors', 'A,B', '--authority', 'x.example', '--auth', '***', '--auth-token', '***', '--authorization', '***', '--oauth', '***', '--x-auth-key', '***', '--AUTH_TOKEN', '***']);
  assert.deepEqual(redactArgs(['--header', 'Author: Jane']), ['--header', 'Author: Jane']);
  assert.deepEqual(redactArgs(['--header', 'X-Auth: abc']), ['--header', 'X-Auth: ***']);
  assert.equal(isSecretPath(['mcpServers', 's', 'author'], 'Jane'), false);
  assert.equal(isSecretPath(['mcpServers', 's', 'authToken'], 'v'), true);
  assert.equal(isSecretPath(['mcpServers', 's', 'args', 0], '--author=Jane'), false);
  assert.equal(isSecretPath(['mcpServers', 's', 'args', 0], '--auth=v'), true);
});

// ---- item 11 / N3: CI matrix and lockfile -------------------------------------

test('#11/N3: CI runs Node 24 and npm ci against a committed zero-dependency lockfile', () => {
  const root = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
  const ci = read(path.join(root, '.github/workflows/ci.yml'));
  assert.match(ci, /node: \[18, 20, 22, 24\]/);
  assert.match(ci, /npm ci/);
  const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
  const pkg = JSON.parse(read(path.join(root, 'package.json')));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(Object.keys(lock.packages), [''], 'zero dependencies');
});

// ---- N4: no orphan .bak ---------------------------------------------------------

test('N4: a failed write removes its .bak (EPERM until retries run out)', async () => {
  const h = makeTree({ '.claude.json': UNPINNED });
  const file = path.join(h, '.claude.json');
  const { configs, rows } = await planned(h);
  let calls = 0;
  const res = pinConfigs(configs, rows, { hooks: {
    rename: () => { calls++; throw Object.assign(new Error('perm'), { code: 'EPERM' }); },
    sleep: () => {},
  } });
  assert.equal(calls, 10);
  assert.ok(res.errors.some((e) => /could not write \(EPERM\)/.test(e)), res.errors.join('\n'));
  assert.equal(read(file), UNPINNED, 'original untouched');
  assert.deepEqual(fs.readdirSync(h), ['.claude.json'], 'no .bak and no temp file left');
  assert.equal(res.files[0].backup, null);
  assert.deepEqual(res.pinned, []);
});

test('N4: any other write error (ENOSPC) also removes the .bak', async () => {
  const h = makeTree({ '.claude.json': UNPINNED });
  const { configs, rows } = await planned(h);
  const res = pinConfigs(configs, rows, { hooks: { rename: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } } });
  assert.ok(res.errors.some((e) => /ENOSPC/.test(e)));
  assert.deepEqual(fs.readdirSync(h), ['.claude.json']);
});

// ---- N5: read-only target ---------------------------------------------------------

test('N5: a read-only config fails fast with "file is read-only": no retries, no .bak', async () => {
  const h = makeTree({ '.claude.json': UNPINNED });
  const file = path.join(h, '.claude.json');
  const { configs, rows } = await planned(h);
  fs.chmodSync(file, 0o444);
  try {
    assert.equal(isReadOnly(file), true);
    let calls = 0;
    const t0 = Date.now();
    const res = pinConfigs(configs, rows, { hooks: { rename: (a, b) => { calls++; return fs.renameSync(a, b); } } });
    assert.equal(calls, 0, 'no rename attempted');
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(res.errors, [`${file}: file is read-only`]);
    assert.equal(read(file), UNPINNED);
    assert.deepEqual(fs.readdirSync(h), ['.claude.json']);
  } finally { fs.chmodSync(file, 0o644); }
  assert.equal(isReadOnly(file), false);
});

test('N5: writable access check covers non-mode denial too', { skip: isRoot || process.platform === 'win32' }, () => {
  const d = makeTree({ 'x.json': '{}' });
  const f = path.join(d, 'x.json');
  fs.chmodSync(f, 0o044); // group/other writable bits off, owner has none
  try { assert.equal(isReadOnly(f), true); } finally { fs.chmodSync(f, 0o644); }
});
