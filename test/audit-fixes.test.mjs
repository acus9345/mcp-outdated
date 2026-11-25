// Regression tests for audit findings:
// 1. pinConfigs clears file.backup when CHANGED aborts before rename.
// 2. Quoted secret flags/headers inside whole-command strings are redacted in
//    both --show-args (cmd /c "...") and --pin --show-args diffs.
// 3. Quoted npm: aliases (--package="npm:pkg") preserve the npm: prefix on --pin.
// 4. URL/git specs after @ (pkg@https://..., pkg@git+...) become unknown and are
//    never queried on registries; non-launcher commands with /npx args stay local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRegistry, makeTree, run } from './helpers.mjs';
import { resolveServer, parseNpmSpec, parsePySpec, HIDDEN } from '../src/resolve.js';
import { loadAll, makeRows, applyLookups } from '../src/check.js';
import { pinConfigs } from '../src/pin.js';
import { renderPin } from '../src/format.js';
import { redactArgs } from '../src/redact.js';

let reg;
before(async () => { reg = await startRegistry(); });
after(() => reg.close());

const noFiles = { exists: () => false };
const base = (h) => ['--home', h, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--no-color'];
const read = (f) => fs.readFileSync(f, 'utf8');

test('pinConfigs clears file.backup when CHANGED aborts before rename', async () => {
  const input = '{\n  "mcpServers": {\n    "a": {"command": "npx", "args": ["-y", "pkg"]}\n  }\n}\n';
  const home = makeTree({ '.claude.json': input });
  const loaded = loadAll({ home, project: makeTree({}), env: {} });
  const rows = makeRows(loaded.configs);
  await applyLookups(rows, { npmRegistry: reg.url, pypiUrl: reg.url, timeout: 2000 });
  const res = pinConfigs(loaded.configs, rows, { hooks: { beforeRename: (t) => fs.appendFileSync(t, ' ') } });
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].written, false);
  assert.equal(res.files[0].backup, null);
  assert.ok(!fs.existsSync(path.join(home, '.claude.json.bak')));
  const rendered = renderPin(res, { color: false, dryRun: false, home });
  assert.doesNotMatch(rendered, /backup:/);
});

test('quoted secret headers and spaced secret values in command strings are redacted', async () => {
  assert.deepEqual(
    redactArgs(['/c', 'npx -y pkg --header "X-Api-Key: plainSECRET1" --api-key "my SECRET2"']),
    ['/c', 'npx -y pkg --header "X-Api-Key: ***" --api-key ***'],
  );
  assert.deepEqual(
    redactArgs(['/c', 'npx -y pkg --header="X-Auth: plainSECRET3"']),
    ['/c', 'npx -y pkg --header=X-Auth: ***'],
  );

  const input = JSON.stringify({
    mcpServers: {
      a: { command: 'npx -y pkg --header "X-Api-Key: plainSECRET1"' },
      b: { command: 'npx -y pkg --header="X-Auth: plainSECRET2"' },
      c: { command: 'cmd', args: ['/c', 'npx -y pkg --api-key "spaced SECRET3" --header "X-Api-Key: plainSECRET4"'] },
    },
  }, null, 2) + '\n';
  const home = makeTree({ '.cursor/mcp.json': input });
  for (const extra of [['--show-args'], ['--show-args', '--json'], ['--pin', '--dry-run', '--show-args'], ['--pin', '--dry-run', '--show-args', '--json']]) {
    const r = await run([...base(home), ...extra]);
    assert.doesNotMatch(r.stdout + r.stderr, /plainSECRET|spaced SECRET/i, `leaked in ${extra.join(' ')}:\n${r.stdout}`);
  }
  const pinOut = await run([...base(home), '--pin', '--dry-run', '--show-args']);
  assert.match(pinOut.stdout, /\(line not shown:/);
});

test('--pin preserves npm: alias inside quoted --package="npm:pkg"', async () => {
  const input = JSON.stringify({
    mcpServers: {
      a: { command: 'npx', args: ['--package="npm:pkg"', 'pkg-bin'] },
    },
  }, null, 2) + '\n';
  const home = makeTree({ '.cursor/mcp.json': input });
  const r = await run([...base(home), '--pin']);
  assert.equal(r.code, 0);
  assert.match(read(path.join(home, '.cursor', 'mcp.json')), /"--package=\\"npm:pkg@3\.2\.1\\""/);
});

test('URL/git specs after @ are rejected and non-launcher paths with /npx args stay local', async () => {
  assert.equal(parseNpmSpec('pkg@https://evil.com/pkg.tgz?token=SECRET'), null);
  assert.equal(parseNpmSpec('pkg@git+https://user:SECRET@github.com/a/b'), null);
  assert.equal(parsePySpec('pkg@git+git@github.com:user/repo'), null);
  assert.equal(parsePySpec('pkg@file:///tmp/pkg'), null);

  const servers = {
    npmurl: { command: 'npx', args: ['-y', 'pkg@https://evil.com/x.tgz?token=LEAK1'] },
    pygit: { command: 'uvx', args: ['pkg@git+git@github.com:user/repo'] },
    notnpx: { command: '/usr/local/bin/my-tool --dir /opt/npx', args: ['--v'] },
    winnpx: { command: 'C:\\tools\\my-tool --dir \\opt\\npx' },
    emptyurl: { command: 'npx', args: ['-y', 'pkg'], url: '' },
  };
  assert.equal(resolveServer(servers.notnpx, noFiles).kind, 'local');
  assert.equal(resolveServer(servers.notnpx, noFiles).display, 'my-tool');
  assert.equal(resolveServer(servers.winnpx, noFiles).kind, 'local');
  assert.equal(resolveServer(servers.winnpx, noFiles).display, 'my-tool');
  assert.equal(resolveServer(servers.emptyurl, noFiles).kind, 'package');

  const home = makeTree({ '.cursor/mcp.json': JSON.stringify({ mcpServers: servers }, null, 2) + '\n' });
  const beforeCount = reg.requests.length;
  const r = await run([...base(home), '--json']);
  const sent = reg.requests.slice(beforeCount).map((q) => q.url);
  assert.deepEqual(sent, ['/pkg'], 'only emptyurl (real npx pkg) was looked up');
  const by = Object.fromEntries(JSON.parse(r.stdout).servers.map((s) => [s.server, s]));
  assert.equal(by.npmurl.status, 'unknown');
  assert.equal(by.npmurl.package, HIDDEN);
  assert.equal(by.pygit.status, 'unknown');
  assert.equal(by.pygit.package, HIDDEN);
  assert.equal(by.notnpx.status, 'local');
  assert.equal(by.notnpx.package, 'my-tool');
  assert.equal(by.emptyurl.status, 'unpinned');
  assert.doesNotMatch(r.stdout + r.stderr, /LEAK1|evil\.com/i);
});
