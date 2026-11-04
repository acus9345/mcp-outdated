// Regression tests for the Windows review of 32383f1 (findings 1-7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startRegistry, makeTree, run, FIXTURES } from './helpers.mjs';
import { resolveServer, splitCommand, launcherName, findPackage, RUNNERS } from '../src/resolve.js';
import { candidates } from '../src/discover.js';
import { loadAll, makeRows, applyLookups } from '../src/check.js';
import { pinConfigs, renameWithRetry, atomicWrite } from '../src/pin.js';
import { compareVersions, comparePep440, compareSemver, isPrerelease } from '../src/version.js';
import { pickPypi, pickNpm } from '../src/registry.js';

let reg;
before(async () => {
  reg = await startRegistry();
});
after(() => reg.close());

const pinArgs = (home, extra = []) => ['--home', home, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--pin', ...extra];
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

// ---- F1: mock registry must not leave keep-alive sockets behind ----------

test('F1: mock registry answers with Connection: close and closes promptly', async () => {
  const r = await startRegistry();
  const statuses = [];
  for (const p of ['/pkg', '/nope', '/pypi/mcp-server-fetch/json']) {
    await new Promise((resolve, reject) => {
      http.get(r.url + p, { agent: new http.Agent({ keepAlive: true }) }, (res) => {
        statuses.push([res.statusCode, res.headers.connection]);
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  }
  assert.deepEqual(statuses, [[200, 'close'], [404, 'close'], [200, 'close']]);
  // a request that never gets an answer must not block close()
  const hung = await startRegistry({ hang: ['pkg'] });
  const req = http.get(hung.url + '/pkg', () => {});
  req.on('error', () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const t0 = Date.now();
  await Promise.all([r.close(), hung.close()]);
  assert.ok(Date.now() - t0 < 1000, 'close() resolves quickly even with an open request');
  for (let i = 0; i < 50 && hung.openSockets; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hung.openSockets, 0, 'all sockets destroyed');
});

// ---- F2: launcher value flags; unknown flags fail safe -------------------

const pkgOf = (entry) => {
  const r = resolveServer(entry);
  return r.kind === 'package' ? `${r.name}@${r.version}` : r.kind;
};

test('F2: known value-taking flags are skipped with their value', () => {
  const cases = [
    [{ command: 'npx', args: ['-y', '--loglevel', 'silent', 'pkg'] }, 'pkg@'],
    [{ command: 'npx', args: ['--registry', 'https://r.example', '-y', 'pkg@1.0.0'] }, 'pkg@1.0.0'],
    [{ command: 'npx', args: ['--cache', '/tmp/c', '--userconfig', '/tmp/rc', 'pkg'] }, 'pkg@'],
    [{ command: 'npx', args: ['-p', 'pkg@2.0.0', '-c', 'pkg-bin --x'] }, 'pkg@2.0.0'],
    [{ command: 'npx', args: ['--call', 'pkg-bin', '--package', 'pkg'] }, 'pkg@'],
    [{ command: 'npm', args: ['exec', '--loglevel', 'warn', '--', 'pkg'] }, 'pkg@'],
    [{ command: 'pnpm', args: ['dlx', '--reporter', 'silent', 'pkg'] }, 'pkg@'],
    [{ command: 'pnpm', args: ['dlx', '-c', 'pkg'] }, 'pkg@'], // -c is --shell-mode (boolean) for pnpm
    [{ command: 'yarn', args: ['dlx', '-q', '-p', 'pkg@1.2.3', 'bin'] }, 'pkg@1.2.3'],
    [{ command: 'bunx', args: ['--bun', 'pkg'] }, 'pkg@'],
    [{ command: 'uvx', args: ['--python', '3.12', 'mcp-server-fetch'] }, 'mcp-server-fetch@'],
    [{ command: 'uvx', args: ['--with', 'httpx', '--index-url', 'https://i.example/simple', 'mcp-server-fetch==1.0'] }, 'mcp-server-fetch@1.0'],
    [{ command: 'uvx', args: ['--from', 'mcp-server-git==0.6.0', 'mcp-server-git'] }, 'mcp-server-git@0.6.0'],
    [{ command: 'uv', args: ['tool', 'run', '-p', '3.11', '--refresh', 'mcp-server-time'] }, 'mcp-server-time@'],
    [{ command: 'pipx', args: ['run', '--python', 'python3.12', '--index-url', 'https://i.example', 'mcp-server-time'] }, 'mcp-server-time@'],
    [{ command: 'pipx', args: ['run', '--spec', 'mcp-server-git==1.0', 'mcp-server-git'] }, 'mcp-server-git@1.0'],
  ];
  for (const [entry, want] of cases) assert.equal(pkgOf(entry), want, JSON.stringify(entry));
});

test('F2: --flag=value forms', () => {
  assert.equal(pkgOf({ command: 'npx', args: ['--loglevel=silent', '-y', 'pkg'] }), 'pkg@');
  assert.equal(pkgOf({ command: 'npx', args: ['--weird=1', 'pkg'] }), 'pkg@', 'unknown --flag=value is self-contained');
  assert.equal(pkgOf({ command: 'npx', args: ['--package=pkg@1.0.0', 'bin'] }), 'pkg@1.0.0');
  assert.equal(pkgOf({ command: 'uvx', args: ['--python=3.12', '--from=mcp-server-git==2.0', 'mcp-server-git'] }), 'mcp-server-git@2.0');
  assert.equal(pkgOf({ command: 'pipx', args: ['run', '--spec=mcp-server-time==1.0', 'mcp-server-time'] }), 'mcp-server-time@1.0');
});

test('F2: an unknown flag that could swallow the package makes the row unknown', () => {
  for (const entry of [
    { command: 'npx', args: ['-y', '--weird', 'x', 'pkg'] },
    { command: 'npx', args: ['--frobnicate', 'pkg'] },
    { command: 'uvx', args: ['--mystery', 'val', 'mcp-server-fetch'] },
    { command: 'pipx', args: ['run', '--mystery', 'mcp-server-fetch'] },
    { command: 'docker', args: ['run', '--mystery', 'thing', 'mcp/fetch'] },
  ]) {
    const r = resolveServer(entry);
    assert.equal(r.kind, 'unknown', JSON.stringify(entry));
    assert.match(r.reason, /unknown .*option --(weird|frobnicate|mystery)/);
  }
  // harmless unknown flags: followed by another flag, or after an explicit -p
  assert.equal(pkgOf({ command: 'npx', args: ['--frobnicate', '-y', 'pkg'] }), 'pkg@');
  assert.equal(pkgOf({ command: 'npx', args: ['-p', 'pkg@1.0.0', '--frob', 'x', 'bin'] }), 'pkg@1.0.0');
  // bundled known booleans and --no-* negations
  assert.equal(pkgOf({ command: 'uvx', args: ['-qn', 'mcp-server-time'] }), 'mcp-server-time@');
  assert.equal(pkgOf({ command: 'npx', args: ['--no-fund', 'pkg'] }), 'pkg@');
  assert.equal(pkgOf({ command: 'docker', args: ['run', '-it', '--rm', 'mcp/fetch:1.0'] }), 'mcp/fetch@1.0');
  assert.deepEqual(findPackage([{ value: '--zap' }, { value: 'p' }], RUNNERS.npx), { ambiguous: '--zap' });
});

test('F2: --pin never rewrites an ambiguous entry (npx -y --weird x pkg) but fixes --loglevel', async () => {
  const input = JSON.stringify({ mcpServers: {
    amb: { command: 'npx', args: ['-y', '--weird', 'x', 'pkg'] },
    log: { command: 'npx', args: ['-y', '--loglevel', 'silent', 'pkg'] },
  } }, null, 2) + '\n';
  const home = makeTree({ '.cursor/mcp.json': input });
  const r = await run(pinArgs(home, ['--json']));
  const out = JSON.parse(r.stdout);
  assert.equal(out.servers.find((s) => s.server === 'amb').status, 'unknown');
  const text = read(home, '.cursor', 'mcp.json');
  assert.equal(text, input.replace('"silent",\n        "pkg"', '"silent",\n        "pkg@3.2.1"'));
  assert.ok(text.includes('"silent"'), '--loglevel value untouched');
  assert.ok(text.includes('"x",\n        "pkg"\n'), 'ambiguous entry untouched');
});

// ---- F3: read/write race and atomic write --------------------------------

async function planned(home) {
  const loaded = loadAll({ home, project: makeTree({}), env: {} });
  const rows = makeRows(loaded.configs);
  await applyLookups(rows, { npmRegistry: reg.url, pypiUrl: reg.url, timeout: 2000 });
  return { configs: loaded.configs, rows };
}

const RACE_IN = '{\n  "mcpServers": {\n    "a": {"command": "npx", "args": ["-y", "pkg"]}\n  }\n}\n';

test('F3: file rewritten between load and pin (token moved) is skipped untouched', async () => {
  const home = makeTree({ '.claude.json': RACE_IN });
  const file = path.join(home, '.claude.json');
  const { configs, rows } = await planned(home);
  // Claude Code rewrites its state file meanwhile: new key in front shifts offsets.
  const changed = '{\n  "numStartups": 42,\n  "mcpServers": {\n    "a": {"command": "npx", "args": ["-y", "pkg"]}\n  }\n}\n';
  fs.writeFileSync(file, changed);
  const res = pinConfigs(configs, rows);
  assert.equal(fs.readFileSync(file, 'utf8'), changed, 'concurrent edit preserved');
  assert.deepEqual(res.files.map((f) => [f.written, f.backup]), [[false, null]], 'reported as not written');
  assert.ok(res.errors.some((e) => e.endsWith('changed during run, re-run')), res.errors.join('\n'));
  assert.ok(!fs.existsSync(file + '.bak'), 'no backup taken for a skipped file');
});

test('F3: token value changed in place is skipped too', async () => {
  const home = makeTree({ '.claude.json': RACE_IN });
  const file = path.join(home, '.claude.json');
  const { configs, rows } = await planned(home);
  const changed = RACE_IN.replace('"pkg"', '"pkx"');
  fs.writeFileSync(file, changed);
  const res = pinConfigs(configs, rows);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.ok(res.errors.some((e) => /changed during run, re-run/.test(e)));
});

test('F3: change after the token keeps both edits (applied to the fresh bytes)', async () => {
  const home = makeTree({ '.claude.json': RACE_IN });
  const file = path.join(home, '.claude.json');
  const { configs, rows } = await planned(home);
  const changed = RACE_IN.replace('\n}\n', ',\n  "tipsHistory": {"x": 1}\n}\n');
  fs.writeFileSync(file, changed);
  const res = pinConfigs(configs, rows);
  assert.deepEqual(res.errors, []);
  assert.equal(fs.readFileSync(file, 'utf8'), changed.replace('"pkg"', '"pkg@3.2.1"'));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), changed, '.bak holds the bytes we actually replaced');
});

test('F3: change in the last moment before rename aborts; no temp files left', async () => {
  const home = makeTree({ '.claude.json': RACE_IN });
  const file = path.join(home, '.claude.json');
  const { configs, rows } = await planned(home);
  const res = pinConfigs(configs, rows, { hooks: { beforeRename: (t) => fs.appendFileSync(t, ' ') } });
  assert.equal(fs.readFileSync(file, 'utf8'), RACE_IN + ' ');
  assert.ok(res.errors.some((e) => /changed during run, re-run/.test(e)));
  assert.deepEqual(fs.readdirSync(home).sort(), ['.claude.json']);
});

test('F3: atomic write via temp+rename; retries EPERM/EBUSY; follows symlinks; no leftovers', async () => {
  const home = makeTree({ '.claude.json': RACE_IN });
  const file = path.join(home, '.claude.json');
  const { configs, rows } = await planned(home);
  let calls = 0;
  const flaky = (from, to) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    if (calls === 2) throw Object.assign(new Error('perm'), { code: 'EPERM' });
    assert.ok(path.basename(from).endsWith('.tmp') && path.dirname(from) === path.dirname(to), 'temp file lives next to the target');
    return fs.renameSync(from, to);
  };
  const res = pinConfigs(configs, rows, { hooks: { rename: flaky } });
  assert.deepEqual(res.errors, []);
  assert.equal(calls, 3);
  assert.equal(read(file), RACE_IN.replace('"pkg"', '"pkg@3.2.1"'));
  assert.deepEqual(fs.readdirSync(home).sort(), ['.claude.json', '.claude.json.bak']);

  // gives up after N attempts and cleans its temp file
  const dir = makeTree({ 'f.json': 'old' });
  const target = path.join(dir, 'f.json');
  assert.throws(() => atomicWrite(target, 'new', { rename: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, sleep: () => {}, attempts: 3 }), /x/);
  assert.equal(read(target), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['f.json']);
  // non-retryable errors are thrown at once
  let n = 0;
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { n++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, sleep: () => {} }));
  assert.equal(n, 1);

  if (process.platform !== 'win32') {
    const real = makeTree({ 'dotfiles/claude.json': RACE_IN });
    const h2 = makeTree({});
    fs.symlinkSync(path.join(real, 'dotfiles', 'claude.json'), path.join(h2, '.claude.json'));
    const p2 = await planned(h2);
    pinConfigs(p2.configs, p2.rows);
    assert.ok(fs.lstatSync(path.join(h2, '.claude.json')).isSymbolicLink(), 'symlink kept');
    assert.equal(read(real, 'dotfiles', 'claude.json'), RACE_IN.replace('"pkg"', '"pkg@3.2.1"'));
  }
});

// ---- F4: Microsoft Store (MSIX) Claude Desktop ---------------------------

test('F4: MSIX Claude Desktop config under AppData/Local/Packages is discovered with --home', async () => {
  const cfg = JSON.stringify({ preferences: { sidebarMode: 'chat' }, mcpServers: { mem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.8.1'] } } });
  const cfg2 = JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['@modelcontextprotocol/server-filesystem@1.0.0'] } } });
  const home = makeTree({
    'AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json': cfg,
    'AppData/Local/Packages/AnthropicPBC.Claude_fnn82j28hfe8t/LocalCache/Roaming/Claude/claude_desktop_config.json': cfg2,
    'AppData/Local/Packages/Microsoft.WindowsCalculator_8wekyb3d8bbwe/LocalCache/Roaming/Claude/claude_desktop_config.json': cfg2,
  });
  const r = await run(['--home', home, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--json']);
  const out = JSON.parse(r.stdout);
  const servers = out.servers.map((s) => `${s.client}/${s.server}/${s.status}`).sort();
  assert.deepEqual(servers, ['claude-desktop/fs/outdated', 'claude-desktop/mem/ok']);
  assert.ok(out.configs.some((c) => c.file.includes(path.join('Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'))));
});

test('F4 + path.win32: Windows candidate list, including MSIX packages and env dirs', () => {
  const W = path.win32;
  const readdir = (dir) => (dir.toLowerCase() === 'c:\\users\\me\\appdata\\local\\packages' ? ['Claude_pzs8sxrjxfjjc', 'Microsoft.Foo_123', 'AnthropicPBC.Claude_fnn82j28hfe8t'] : []);
  const list = candidates({ home: 'C:\\Users\\me', project: 'D:\\code\\app', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', CODEX_HOME: 'E:\\codex' }, pathMod: W, platform: 'win32', readdir });
  assert.deepEqual(list.map((c) => `${c.client} ${c.file}`), [
    'claude-code D:\\code\\app\\.mcp.json',
    'claude-code C:\\Users\\me\\.claude.json',
    'claude-desktop C:\\Users\\me\\Library\\Application Support\\Claude\\claude_desktop_config.json',
    'claude-desktop C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
    'claude-desktop C:\\Users\\me\\.config\\Claude\\claude_desktop_config.json',
    'claude-desktop C:\\Users\\me\\AppData\\Local\\Packages\\AnthropicPBC.Claude_fnn82j28hfe8t\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
    'claude-desktop C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
    'cursor C:\\Users\\me\\.cursor\\mcp.json',
    'cursor D:\\code\\app\\.cursor\\mcp.json',
    'vscode D:\\code\\app\\.vscode\\mcp.json',
    'codex E:\\codex\\config.toml',
  ]);
  // --home ignores %LOCALAPPDATA% / %APPDATA% from the environment
  const seen = [];
  candidates({ home: 'C:\\fixture', project: 'C:\\p', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, homeOverride: true, pathMod: W, platform: 'win32', readdir: (d) => (seen.push(d), []) });
  assert.deepEqual(seen, ['C:\\fixture\\AppData\\Local\\Packages']);
});

// ---- F5: PEP 440 and SemVer ordering --------------------------------------

test('F5: PEP 440 ordering (epochs, pre, post, dev, local, normalisation)', () => {
  const ordered = ['1.0.dev0', '1.0a1.dev1', '1.0a1', '1.0a2', '1.0b1', '1.0rc1', '1.0', '1.0+local.1', '1.0+local.2', '1.0+5', '1.0.post1.dev1', '1.0.post1', '1.0.1', '1.1.dev1', '1.1', '2!0.1'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(comparePep440(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
  }
  for (const [a, b] of [['1.0', '1.0.0'], ['1.0alpha1', '1.0a1'], ['1.0c1', '1.0rc1'], ['1.0-preview.1', '1.0rc1'], ['1.0-1', '1.0.post1'], ['1.0.r', '1.0.post0'], ['v1.0', '1.0'], ['0!1.0', '1.0'], ['1.0RC1', '1.0rc1']]) {
    assert.equal(comparePep440(a, b), 0, `${a} == ${b}`);
  }
  assert.equal(comparePep440('not a version', '1.0'), null);
  assert.ok(comparePep440('2025.10.1', '2025.9.30') > 0);
  assert.ok(isPrerelease('1.0rc1', 'pypi') && isPrerelease('1.0.dev3', 'pypi') && !isPrerelease('1.0.post1', 'pypi'));
});

test('F5: SemVer 2.0 pre-release ordering for npm', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) assert.ok(compareSemver(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0, 'build metadata ignored');
  assert.ok(compareVersions('0.0.41', '0.0.9', 'npm') > 0);
  assert.ok(isPrerelease('2.0.0-next.3', 'npm') && !isPrerelease('2.0.0', 'npm'));
});

test('F5: PyPI latest skips pre-releases and yanked releases; npm uses dist-tags', () => {
  const body = { info: { version: '2.0.0b1' }, releases: { '1.0.0': [{ yanked: false }], '1.1.0': [{ yanked: true }], '1.0.5': [{ yanked: true }, { yanked: false }], '2.0.0b1': [{ yanked: false }], '3.0.0': [] } };
  assert.deepEqual(pickPypi(body), { version: '1.0.5', prerelease: '2.0.0b1' });
  assert.deepEqual(pickPypi({ info: { version: '0.3' }, releases: {} }), { version: '0.3', prerelease: '0.3' });
  assert.deepEqual(pickPypi({ info: { version: '0.1a1' }, releases: { '0.1a1': [{}] } }), { version: '0.1a1', prerelease: '0.1a1' }, 'only pre-releases: use them');
  assert.deepEqual(pickNpm({ 'dist-tags': { latest: '1.2.0' }, versions: { '1.2.0': {}, '2.0.0-rc.1': {}, '2.0.0-rc.2': { deprecated: 'x' } } }), { version: '1.2.0', prerelease: '2.0.0-rc.1' });
});

test('F5: end to end: stable pins compare to stable latest, pre-release pins to the newest pre-release', async () => {
  const r2 = await startRegistry({
    npm: { 'np': { latest: '1.2.0', versions: ['1.2.0', '2.0.0-beta.2', '2.0.0-beta.10'] } },
    pypi: {
      'pa': { version: '3.0.0rc1', releases: { '2.0.0': 'ok', '2.1.0': 'yanked', '3.0.0rc1': 'ok', '3.0.0rc2': 'ok', '4.0': 'nofiles' } },
    },
  });
  try {
    const cfg = JSON.stringify({ mcpServers: {
      s1: { command: 'npx', args: ['np@1.2.0'] },
      s2: { command: 'npx', args: ['np@2.0.0-beta.2'] },
      s3: { command: 'uvx', args: ['pa==2.0.0'] },
      s4: { command: 'uvx', args: ['pa==3.0.0rc1'] },
      s5: { command: 'uvx', args: ['pa'] },
      s6: { command: 'uvx', args: ['pa==2.0.0.post1'] },
    } });
    const home = makeTree({ '.cursor/mcp.json': cfg });
    const r = await run(['--home', home, '--project', makeTree({}), '--npm-registry', r2.url, '--pypi-url', r2.url, '--json']);
    const got = Object.fromEntries(JSON.parse(r.stdout).servers.map((s) => [s.server, `${s.status} ${s.latest}`]));
    assert.deepEqual(got, {
      s1: 'ok 1.2.0',
      s2: 'outdated 2.0.0-beta.10',
      s3: 'ok 2.0.0',
      s4: 'outdated 3.0.0rc2',
      s5: 'unpinned 2.0.0',
      s6: 'ok 2.0.0',
    });
    // --pin uses the stable latest, never a pre-release or a yanked version
    await run(['--home', home, '--project', makeTree({}), '--npm-registry', r2.url, '--pypi-url', r2.url, '--pin']);
    assert.ok(read(home, '.cursor', 'mcp.json').includes('"pa==2.0.0"]}'), read(home, '.cursor', 'mcp.json'));
  } finally {
    await r2.close();
  }
});

// ---- F6: command paths with spaces; Windows launchers --------------------

const noFiles = { exists: () => false };

test('F6: launcher basename is case-insensitive and strips .cmd/.exe/.ps1/.bat', () => {
  for (const c of ['NPX.CMD', 'npx.exe', 'C:\\Program Files\\nodejs\\npx.cmd', 'C:/tools/Npx.PS1', '/usr/local/bin/npx', 'npx.bat']) assert.equal(launcherName(c), 'npx', c);
  assert.equal(launcherName('C:\\Users\\me\\.local\\bin\\uvx.exe'), 'uvx');
});

test('F6: command path with spaces + separate args is never split', () => {
  const r = resolveServer({ command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'pkg'] }, noFiles);
  assert.equal(r.kind, 'package');
  assert.equal(r.name, 'pkg');
  assert.deepEqual(r.token.loc, { field: 'args', index: 1 });
  // args with spaces/quotes are passed through as single tokens
  const q = resolveServer({ command: 'npx', args: ['-y', 'pkg', '--root', 'C:\\My Files\\x', '"quoted arg"'] }, noFiles);
  assert.equal(q.name, 'pkg');
  assert.equal(resolveServer({ command: 'NPX.CMD', args: ['-y', 'pkg@1.0.0'] }, noFiles).version, '1.0.0');
});

test('F6: a lone command path containing spaces stays one path', () => {
  const lone = resolveServer({ command: 'C:\\Program Files\\My Server\\server.exe' }, noFiles);
  assert.equal(lone.kind, 'local');
  assert.equal(lone.launcher, 'server');
  const existing = resolveServer({ command: 'C:\\Program Files\\nodejs\\npx.cmd' }, { exists: (p) => p === 'C:\\Program Files\\nodejs\\npx.cmd' });
  assert.equal(existing.kind, 'unknown');
  assert.equal(existing.reason, 'no package argument');
});

test('F6: whole-command strings: quote-aware split, backslashes literal', () => {
  assert.deepEqual(splitCommand('"C:\\Program Files\\nodejs\\npx.cmd" -y \'my pkg\' C:\\a\\b').map((w) => w.value), ['C:\\Program Files\\nodejs\\npx.cmd', '-y', 'my pkg', 'C:\\a\\b']);
  const quoted = resolveServer({ command: '"C:\\Program Files\\nodejs\\npx.cmd" -y pkg' }, noFiles);
  assert.equal(quoted.name, 'pkg');
  assert.deepEqual(quoted.token.loc, { field: 'command', start: 37, end: 40, raw: 'pkg' });
  const bare = resolveServer({ command: 'C:\\Program Files\\nodejs\\npx.cmd -y pkg@1.0.0' }, noFiles);
  assert.equal(bare.launcher, 'npx');
  assert.equal(bare.version, '1.0.0');
  const viaDisk = resolveServer({ command: 'C:\\Program Files\\odd tool\\run me.exe --flag' }, { exists: (p) => p === 'C:\\Program Files\\odd tool\\run me.exe' });
  assert.equal(viaDisk.kind, 'local');
  assert.equal(viaDisk.launcher, 'run me');
  const wrapped = resolveServer({ command: 'cmd /c "C:\\Program Files\\nodejs\\npx.cmd" -y "@scope/pkg"' }, noFiles);
  assert.equal(wrapped.name, '@scope/pkg');
});

test('F6: --pin rewrites inside a quoted whole-command string and keeps quotes and backslashes', async () => {
  const doc = { mcpServers: {
    w: { command: '"C:\\Program Files\\nodejs\\npx.cmd" -y "pkg" --root "C:\\My Files"' },
    x: { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'pkg'] },
  } };
  const input = JSON.stringify(doc) + '\n';
  const want = JSON.parse(input);
  want.mcpServers.w.command = '"C:\\Program Files\\nodejs\\npx.cmd" -y "pkg@3.2.1" --root "C:\\My Files"';
  want.mcpServers.x.args[1] = 'pkg@3.2.1';
  const home = makeTree({ '.cursor/mcp.json': input });
  const r = await run(pinArgs(home));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(read(home, '.cursor', 'mcp.json'), JSON.stringify(want) + '\n');
});

// ---- F7: fixtures stay byte-exact (CRLF fixture is committed as CRLF) ----

test('F7: CRLF fixture keeps its CRLF bytes and pin preserves them', async () => {
  const src = path.join(FIXTURES, 'crlf', '.cursor', 'mcp.json');
  const bytes = fs.readFileSync(src, 'utf8');
  assert.ok(bytes.includes('\r\n'), 'fixture checked out with CRLF (see .gitattributes)');
  assert.ok(!/[^\r]\n/.test(bytes), 'every LF is part of a CRLF');
  const home = makeTree({ '.cursor/mcp.json': bytes });
  await run(pinArgs(home));
  const out = read(home, '.cursor', 'mcp.json');
  assert.equal(out, bytes.replace('"pkg"', '"pkg@3.2.1"'));
  const attrs = fs.readFileSync(path.join(FIXTURES, '..', '..', '.gitattributes'), 'utf8');
  assert.match(attrs, /^test\/fixtures\/\*\* -text$/m);
});
