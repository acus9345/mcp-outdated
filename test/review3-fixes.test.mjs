// Regression tests for review round 3: H-1 (URL tail shown as a local
// "package") with defence-in-depth redaction, and L-1 (pin summary on failure).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRegistry, makeTree, run } from './helpers.mjs';
import { resolveServer, commandName, HIDDEN } from '../src/resolve.js';
import { loadAll, makeRows, applyLookups, sanitizeRows } from '../src/check.js';
import { pinConfigs } from '../src/pin.js';
import { renderPin } from '../src/format.js';
import { redactValue, redactArgs, isUnsafeName, looksLikeToken } from '../src/redact.js';

let reg;
before(async () => { reg = await startRegistry(); });
after(() => reg.close());

const noFiles = { exists: () => false };
const base = (h) => ['--home', h, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--no-color'];
const MODES = [[], ['--json'], ['--ci'], ['--long'], ['--dry-run'], ['--json', '--dry-run'], ['--show-args'], ['--json', '--show-args'], ['--dry-run', '--show-args'], ['--ci', '--show-args', '--long']];

async function allOutputs(h) {
  const outs = [];
  for (const m of MODES) {
    const r = await run([...base(h), ...m]);
    outs.push({ mode: m.join(' ') || 'default', text: r.stdout + r.stderr });
  }
  return outs;
}

// ---- H-1: the review's exact repros ----------------------------------------------

const SLACK = 'Xk9pQ2mZ7vR4tL8wN3yH6sJd';
const STRIPE = ['sk', 'live', '51HxQyZ2eZvKYlo2CabcdEFGH'].join('_');
const GHP = 'ghp_abcdefghijklmnop1234';
const REPROS = {
  slack: { command: `/usr/local/bin/slack-mcp https://hooks.slack.com/services/T0AAAA/B0BBBB/${SLACK}` },
  stripe: { command: `C:\\tools\\mcp-proxy --url https://api.example.com/sse/${STRIPE}` },
  cmdghp: { command: 'cmd', args: ['/c', `C:\\tools\\mcp-proxy https://api.example.com/sse/${GHP}`] },
  exe: { command: `C:\\tools\\mcp-proxy.exe https://api.example.com/sse/${GHP}` },
  // short, low-entropy tail: only the split-first rule protects it
  shorttail: { command: '/opt/bin/notify https://hooks.example.com/x/y/plainTAIL' },
  wintail: { command: 'C:\\Program Files\\Notify\\notify https://hooks.example.com/x/plainWINTAIL' },
  explicit: { command: '/opt/bin/notify https://hooks.example.com/x/plainEXPLICIT', args: ['--v'] },
};
const REPRO_SECRET = new RegExp([SLACK, STRIPE, GHP, 'plainTAIL', 'plainWINTAIL', 'plainEXPLICIT', 'T0AAAA', 'B0BBBB', 'sk_live', 'ghp_'].join('|'), 'i');

test('H-1: review repros: no URL tail or token in table, --json, --ci, --dry-run, with and without --show-args', async () => {
  const h = makeTree({ '.cursor/mcp.json': JSON.stringify({ mcpServers: REPROS }, null, 2) + '\n' });
  for (const o of await allOutputs(h)) assert.doesNotMatch(o.text, REPRO_SECRET, `[${o.mode}]\n${o.text}`);
  const j = JSON.parse((await run([...base(h), '--json'])).stdout);
  const by = Object.fromEntries(j.servers.map((s) => [s.server, s]));
  assert.equal(by.slack.package, 'slack-mcp');
  assert.equal(by.slack.launcher, 'slack-mcp');
  assert.equal(by.stripe.package, 'mcp-proxy');
  assert.equal(by.cmdghp.package, 'mcp-proxy');
  assert.equal(by.exe.package, 'mcp-proxy');
  assert.equal(by.shorttail.package, 'notify');
  assert.equal(by.explicit.package, 'notify');
  for (const s of j.servers) for (const v of [s.package, s.launcher]) assert.doesNotMatch(v, /[/\\:?=@\s]/, JSON.stringify(s));
});

test('H-1: executable name comes from the first word, POSIX and win32 path styles', () => {
  const cases = [
    ['/usr/local/bin/slack-mcp https://hooks.slack.com/services/T/B/zzz', 'slack-mcp'],
    ['C:\\tools\\mcp-proxy --url https://h/x/zzz', 'mcp-proxy'],
    ['C:/tools/mcp-proxy https://h/x/zzz', 'mcp-proxy'],
    ['./bin/server https://h/zzz', 'server'],
    ['"C:\\Program Files\\X\\srv.exe" https://h/zzz', 'srv'],
    ['C:\\Program Files\\X\\srv.exe https://h/zzz', 'srv'],
    ["'/opt/my tools/srv' https://h/zzz", 'srv'],
  ];
  for (const [command, want] of cases) {
    const r = resolveServer({ command }, noFiles);
    assert.equal(r.kind, 'local', command);
    assert.equal(r.display, want, command);
  }
  // cmd /c "<path> <url>" with a single inner string
  assert.equal(resolveServer({ command: 'cmd', args: ['/c', 'C:\\tools\\mcp-proxy https://h/a/zzz'] }, noFiles).display, 'mcp-proxy');
  assert.equal(resolveServer({ command: 'cmd', args: ['/d', '/s', '/c', '/opt/x/srv https://h/zzz'] }, noFiles).display, 'srv');
});

test('H-1: a name derived from URL-ish or credential-looking text is (hidden)', () => {
  for (const value of ['https://hooks.slack.com/services/T/B/zzz', 'C:\\x\\a?token=zzz', 'user:pw@host.example', 'C:\\x\\Zq8vT3kLmN7pR2sW5xY9bC4d', '/x/sk_live_abc123', 'a=b']) {
    assert.equal(commandName({ value, verified: true }), HIDDEN, value);
    assert.equal(commandName({ value }), HIDDEN, value);
  }
  assert.equal(commandName({ value: 'C:\\odd tool\\run me.exe', verified: true }), 'run me');
});

test('H-1: credential- or URL-looking "package" becomes unknown and is never sent to a registry', async () => {
  const servers = {
    tgz: { command: 'npx', args: ['-y', `https://example.com/pkgs/${SLACK}.tgz`] },
    gitplus: { command: 'uvx', args: [`git+https://user:${SLACK}@example.com/r.git`] },
    stripepkg: { command: 'npx', args: ['-y', STRIPE] },
    whsec: { command: 'npx', args: ['-y', 'whsec_abc12345'] },
    query: { command: 'npx', args: ['-y', 'pkg?token=abc'] },
    ok: { command: 'npx', args: ['-y', 'pkg'] },
  };
  const h = makeTree({ '.cursor/mcp.json': JSON.stringify({ mcpServers: servers }, null, 2) + '\n' });
  const before = reg.requests.length;
  const r = await run([...base(h), '--json']);
  const sent = reg.requests.slice(before).map((q) => q.url);
  assert.deepEqual(sent, ['/pkg'], 'only the real package was looked up');
  const by = Object.fromEntries(JSON.parse(r.stdout).servers.map((s) => [s.server, s]));
  for (const k of ['tgz', 'gitplus', 'stripepkg', 'whsec', 'query']) assert.equal(by[k].status, 'unknown', k);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${SLACK}|sk_live|whsec_|token=abc`, 'i'));
});

test('redactor: sk_live_/sk_test_/rk_live_/whsec_ and Slack/Discord/Teams webhooks', () => {
  for (const t of ['sk_live_abc123', 'sk_test_abc123', 'rk_live_abc123', 'pk_live_abc123', 'whsec_abc123']) {
    assert.ok(looksLikeToken(t), t);
    assert.equal(redactValue(`x ${t} y`), 'x *** y');
  }
  assert.equal(redactValue('https://hooks.slack.com/services/T0/B0/abc'), 'https://hooks.slack.com/***');
  assert.equal(redactValue('https://discord.com/api/webhooks/1/abc'), 'https://discord.com/***');
  assert.equal(redactValue('https://discordapp.com/api/webhooks/1/abc'), 'https://discordapp.com/***');
  assert.equal(redactValue('https://acme.webhook.office.com/webhookb2/abc'), 'https://acme.webhook.office.com/***');
  assert.equal(redactValue('https://discord.com/channels/1'), 'https://discord.com/channels/1', 'not a webhook');
  assert.equal(redactValue('https://h.example/a/Zq8vT3kLmN7pR2sW5xY9bC4d/b'), 'https://h.example/a/***/b', 'URL path segments are checked');
  assert.deepEqual(redactArgs(['--url', 'https://h.example/sse/plain']), ['--url', 'https://h.example/***'], '--show-args drops URL paths');
  for (const n of ['pkg', '@scope/name', '@scope/name@1.2.3', 'mcp-server-fetch[cli]', 'ghcr.io/github/github-mcp-server']) assert.equal(isUnsafeName(n), false, n);
  for (const n of ['https://x', 'a=b', 'u@host.example', 'x?y', SLACK, STRIPE, 'hooks.slack.com/services/x']) assert.equal(isUnsafeName(n), true, n);
});

test('defence in depth: sanitizeRows redacts every displayed field', () => {
  const rows = [{ client: 'c', server: `s ${GHP}`, package: 'https://h/x/zzz', launcher: 'a=b', current: STRIPE, latest: '1.0.0', note: `bad ${SLACK}`, status: 'local' },
    { client: 'c', server: 's', package: 'https://remote.example', launcher: '', current: '-', latest: '-', note: '', status: 'remote' }];
  sanitizeRows(rows);
  assert.doesNotMatch(JSON.stringify(rows[0]), REPRO_SECRET);
  assert.equal(rows[0].package, HIDDEN);
  assert.equal(rows[0].launcher, HIDDEN);
  assert.equal(rows[1].package, 'https://remote.example', 'remote origins stay');
});

// ---- fuzz-ish: nonexistent executables followed by many secret shapes -----------

function prng(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

test('fuzz: no secret substring in any output for nonexistent paths + URL/token arguments', async () => {
  const rnd = prng(20261104);
  const secret = () => 'Mk7' + Array.from({ length: 24 }, () => B62[Math.floor(rnd() * 62)]).join('');
  const SHAPES = [
    (s) => `https://hooks.slack.com/services/T0X/B0X/${s}`,
    (s) => `https://discord.com/api/webhooks/123/${s}`,
    (s) => `https://api.example.com/sse/${s}`,
    (s) => `https://api.example.com/v1/${s}/events`,
    (s) => `https://api.example.com/v1?token=${s}`,
    (s) => `https://api.example.com/v1?x=1&key=${s}`,
    (s) => `https://user:${s}@api.example.com/`,
    (s) => `wss://${s}@api.example.com/ws`,
    (s) => `--api-key ${s}`,
    (s) => `--token=${s}`,
    (s) => `--url=https://h.example/${s}`,
    (s) => `sk_live_${s}`,
    (s) => `sk_test_${s}`,
    (s) => `rk_live_${s}`,
    (s) => `whsec_${s}`,
    (s) => `ghp_${s}`,
    (s) => s,
  ];
  const EXES = ['/usr/local/bin/tool', '/opt/My Apps/tool', 'C:\\tools\\tool', 'C:\\Program Files\\Tool Dir\\tool', 'C:\\tools\\tool.exe',
    'C:/tools/tool', './bin/tool', '~/bin/tool', 'tool', '"C:\\Program Files\\Q\\tool.cmd"', "'/opt/q q/tool'"];
  const servers = {};
  const secrets = [];
  let i = 0;
  for (const exe of EXES) {
    for (const shape of SHAPES) {
      const s = secret();
      secrets.push(s);
      const argStr = shape(s);
      const form = i % 5;
      const plainExe = exe.replace(/^["']|["']$/g, '');
      let entry;
      if (form === 0) entry = { command: `${exe} ${argStr}` };
      else if (form === 1) entry = { command: 'cmd', args: ['/c', `${exe} ${argStr}`] };
      else if (form === 2) entry = { command: 'cmd', args: ['/s', '/d', '/c', `${exe} --verbose ${argStr}`] };
      else if (form === 3) entry = { command: plainExe, args: argStr.split(' ') };
      else entry = { command: `${exe} --flag ${argStr}`, env: { X: s } };
      servers[`f${i++}`] = entry;
    }
  }
  const h = makeTree({ '.cursor/mcp.json': JSON.stringify({ mcpServers: servers }, null, 2) + '\n' });
  const leak = new RegExp(secrets.join('|'), 'i');
  for (const o of await allOutputs(h)) {
    const m = leak.exec(o.text);
    assert.equal(m, null, `[${o.mode}] leaked ${m && m[0]}`);
  }
  const j = JSON.parse((await run([...base(h), '--json'])).stdout);
  assert.equal(j.servers.length, EXES.length * SHAPES.length);
  for (const s of j.servers) {
    assert.doesNotMatch(String(s.package), /:\/\/|[?=]|\s/, `${s.server}: ${s.package}`);
    assert.ok(s.package === HIDDEN || /^[\w.+~-]+$/.test(s.package), `${s.server}: ${s.package}`);
  }
});

// ---- L-1: pin summary counts only what was written -------------------------------

const UNPINNED = '{\n  "mcpServers": {\n    "a": {"command": "npx", "args": ["-y", "pkg"]}\n  }\n}\n';

async function planned(home) {
  const loaded = loadAll({ home, project: makeTree({}), env: {} });
  const rows = makeRows(loaded.configs);
  await applyLookups(rows, { npmRegistry: reg.url, pypiUrl: reg.url, timeout: 2000 });
  return { configs: loaded.configs, rows };
}

test('L-1: a failed write is not counted as pinned', async () => {
  const h = makeTree({ '.claude.json': UNPINNED });
  const { configs, rows } = await planned(h);
  const res = pinConfigs(configs, rows, { hooks: { rename: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } } });
  const text = renderPin(res, { color: false, dryRun: false, home: h });
  assert.match(text, /^Pinned 0 entries in 0 file\(s\)\.$/m);
  assert.match(text, /^Not written: 1 entry in 1 file\(s\) \(see warnings\)\.$/m);
  assert.match(text, /\(NOT written\)/);
  assert.doesNotMatch(text, /backup:/);
});

test('L-1: CLI: read-only file and success side by side', async () => {
  const h = makeTree({ '.claude.json': UNPINNED, '.cursor/mcp.json': UNPINNED });
  const ro = path.join(h, '.claude.json');
  fs.chmodSync(ro, 0o444);
  try {
    const r = await run([...base(h), '--pin']);
    assert.match(r.stdout, /^Pinned 1 entry in 1 file\(s\)\.$/m);
    assert.match(r.stdout, /^Not written: 1 entry in 1 file\(s\) \(see warnings\)\.$/m);
    assert.match(r.stderr, /file is read-only/);
    assert.equal(fs.readFileSync(ro, 'utf8'), UNPINNED);
    const j = await run([...base(makeTree({ '.claude.json': UNPINNED })), '--pin', '--json', '--dry-run']);
    assert.equal(JSON.parse(j.stdout).pin.files[0].written, false);
  } finally { fs.chmodSync(ro, 0o644); }
});

test('L-1: dry run wording unchanged', async () => {
  const h = makeTree({ '.claude.json': UNPINNED });
  const r = await run([...base(h), '--pin', '--dry-run']);
  assert.match(r.stdout, /Would pin 1 entry in 1 file\(s\)\. Re-run without --dry-run to write\./);
});
