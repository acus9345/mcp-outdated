// Server arguments are hidden by default; --show-args shows them redacted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRegistry, makeTree, run } from './helpers.mjs';
import { redactArgs, redactValue, looksHighEntropy } from '../src/redact.js';

let reg;
before(async () => {
  reg = await startRegistry();
});
after(() => reg.close());

const ENTROPY = 'Zq8vT3kLmN7pR2sW5xY9bC4d';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
// every secret below contains LEAK (or is ENTROPY / AWS) so one regex finds leaks
const SECRET = new RegExp(`LEAK|hunter2|${ENTROPY}|${AWS}`, 'i');

const SERVERS = {
  apikey: { command: 'npx', args: ['-y', 'pkg@3.2.1', '--api-key', 'sk-proj-LEAK1234567890abcdefgh'] },
  tokeneq: { command: 'npx', args: ['-y', 'pkg@3.2.1', '--token=plainLEAKvalue'] },
  shortk: { command: 'npx', args: ['-y', 'pkg@3.2.1', '-k', 'xyzLEAK'] },
  header: { command: 'npx', args: ['-y', 'pkg@3.2.1', '--header', 'Authorization: Bearer LEAKbearer'] },
  headersplit: { command: 'npx -y pkg@3.2.1 --header Authorization: Bearer LEAKsplit' },
  url: { command: 'npx', args: ['-y', 'pkg@3.2.1', '--endpoint', 'https://bob:hunter2@api.example.com/v1?key=LEAKq&region=eu'] },
  prefixes: { command: 'npx', args: ['-y', 'pkg@3.2.1', 'ghp_LEAKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'xoxb-1234567890-LEAKabcdef', AWS] },
  entropy: { command: 'uvx', args: ['mcp-server-fetch==2025.4.7', ENTROPY] },
  spacepath: { command: 'C:\\Program Files\\My Server\\server.exe --api-key sk-LEAKspacepath1234567890 plainword' },
  posonly: { command: 'C:\\Weird Dir\\tool --password LEAKpw' },
  pkgsecret: { command: 'npx', args: ['-y', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8LEAK'] },
};

function home() {
  return makeTree({ '.cursor/mcp.json': JSON.stringify({ mcpServers: SERVERS }, null, 2) + '\n' });
}
const base = (h) => ['--home', h, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--no-color'];

test('default: no server arguments in the table, --json, --ci or warnings', async () => {
  const h = home();
  const t = await run([...base(h), '--long', '--ci', '--fail-on', 'unknown,unpinned,outdated']);
  assert.doesNotMatch(t.stdout + t.stderr, SECRET);
  assert.doesNotMatch(t.stdout, /--api-key|--token|--header|Authorization|Args|plainword|--endpoint|api\.example/);
  assert.match(t.stderr, /failed --ci/);
  const row = (name) => t.stdout.split('\n').find((l) => l.startsWith(`cursor  ${name} `));
  assert.match(row('apikey'), /pkg\s+3\.2\.1\s+3\.2\.1\s+ok/, 'package and version stay visible');
  assert.match(row('entropy'), /mcp-server-fetch\s+2025\.4\.7/);
  assert.match(row('spacepath'), /\bserver\s+-\s+-\s+local/, 'only the executable name for a space path');
  assert.match(row('posonly'), /\bweird\s+-\s+-\s+local/);
  assert.match(row('pkgsecret'), /unknown/);

  const j = await run([...base(h), '--json', '--ci']);
  assert.doesNotMatch(j.stdout + j.stderr, SECRET);
  assert.doesNotMatch(j.stdout, /plainword|--api-key|api\.example/, 'no positional or flag arguments by default');
  const out = JSON.parse(j.stdout);
  assert.ok(out.servers.every((s) => !('args' in s)), 'no args field by default');
  assert.equal(out.servers.find((s) => s.server === 'pkgsecret').status, 'unknown');
  assert.ok(!reg.requests.some((r) => /LEAK/.test(r.url)), 'secret-looking positional never sent to a registry');
});

test('--show-args: every form is redacted in the table and --json; useful parts stay', async () => {
  const h = home();
  const t = await run([...base(h), '--show-args']);
  assert.doesNotMatch(t.stdout + t.stderr, SECRET);
  const line = (name) => t.stdout.split('\n').find((l) => l.startsWith(`cursor  ${name} `));
  assert.match(t.stdout.split('\n')[0], /Args$/);
  assert.match(line('apikey'), /-y pkg@3\.2\.1 --api-key \*\*\*$/);
  assert.match(line('tokeneq'), /--token=\*\*\*$/);
  assert.match(line('shortk'), /-k \*\*\*$/);
  assert.match(line('header'), /--header "Authorization: \*\*\*"$/);
  assert.match(line('headersplit'), /--header Authorization: \*\*\* \*\*\*$/);
  assert.match(line('url'), /--endpoint https:\/\/bob:\*\*\*@api\.example\.com\/\*\*\*$/, 'URL keeps scheme+host only');
  assert.match(line('prefixes'), /pkg@3\.2\.1 \*\*\* \*\*\* \*\*\*$/);
  assert.match(line('entropy'), /mcp-server-fetch==2025\.4\.7 \*\*\*$/);
  assert.match(line('spacepath'), /--api-key \*\*\* plainword$/, 'plain positionals are shown only with --show-args');

  const j = await run([...base(h), '--show-args', '--json']);
  assert.doesNotMatch(j.stdout, SECRET);
  const args = Object.fromEntries(JSON.parse(j.stdout).servers.map((s) => [s.server, s.args]));
  assert.deepEqual(args.apikey, ['-y', 'pkg@3.2.1', '--api-key', '***']);
  assert.deepEqual(args.tokeneq, ['-y', 'pkg@3.2.1', '--token=***']);
  assert.deepEqual(args.shortk, ['-y', 'pkg@3.2.1', '-k', '***']);
  assert.deepEqual(args.header, ['-y', 'pkg@3.2.1', '--header', 'Authorization: ***']);
  assert.deepEqual(args.headersplit, ['-y', 'pkg@3.2.1', '--header', 'Authorization:', '***', '***']);
  assert.deepEqual(args.url, ['-y', 'pkg@3.2.1', '--endpoint', 'https://bob:***@api.example.com/***']);
  assert.deepEqual(args.prefixes, ['-y', 'pkg@3.2.1', '***', '***', '***']);
  assert.deepEqual(args.entropy, ['mcp-server-fetch==2025.4.7', '***']);
  assert.deepEqual(args.posonly, [], 'unplaceable path with spaces: no args shown at all');
});

test('--show-args leaves positional words alone unless they look like secrets', async () => {
  // plain positional words are shown only with --show-args; default output
  // never shows any argument (see the first test).
  assert.deepEqual(redactArgs(['/tmp', 'C:\\Users\\Me\\AppData\\Roaming', '@modelcontextprotocol/server-filesystem@2.1.0', 'mcp-server-git==2026.1.14', '--loglevel', 'silent', '--port', '8080']),
    ['/tmp', 'C:\\Users\\Me\\AppData\\Roaming', '@modelcontextprotocol/server-filesystem@2.1.0', 'mcp-server-git==2026.1.14', '--loglevel', 'silent', '--port', '8080']);
});

test('the Authorization header in every shape', () => {
  assert.deepEqual(redactArgs(['--header', 'Authorization: Bearer x']), ['--header', 'Authorization: ***']);
  assert.deepEqual(redactArgs(['--header=Authorization: Bearer x']), ['--header=Authorization: ***']);
  assert.deepEqual(redactArgs(['-H', 'Authorization:Bearer x']), ['-H', 'Authorization:***']);
  assert.deepEqual(redactArgs(['--header', 'Authorization:', 'Bearer', 'x', '--next']), ['--header', 'Authorization:', '***', '***', '--next']);
  assert.deepEqual(redactArgs(['--header', 'X-Api-Key: abc']), ['--header', 'X-Api-Key: ***']);
  assert.deepEqual(redactArgs(['--header', 'Accept: application/json']), ['--header', 'Accept: application/json']);
  assert.deepEqual(redactArgs(['Authorization: Bearer x']), ['Authorization: ***']);
  assert.deepEqual(redactArgs(['Bearer', 'x']), ['Bearer', '***']);
});

test('flag-name, URL, prefix and entropy rules', () => {
  for (const f of ['--api-key', '--apikey', '--api_key', '--token', '--access-token', '--secret', '--password', '--pass', '--auth', '--bearer', '--credentials', '--cookie', '--session-id', '-k']) {
    assert.deepEqual(redactArgs([f, 'v']), [f, '***'], f);
    if (f !== '-k') assert.deepEqual(redactArgs([`${f}=v`]), [`${f}=***`], `${f}=`);
  }
  assert.equal(redactValue('https://user:pw@h.example/p?token=t&x=1#access_token=z'), 'https://user:***@h.example/p?token=***&x=1#access_token=***');
  assert.equal(redactValue('https://tok123@h.example/'), 'https://***@h.example/');
  assert.equal(redactValue('API_KEY=abc'), 'API_KEY=***');
  for (const tok of ['sk-ant-api03-abcdefghijklmnop', 'ghp_abcdefghijklmnopqrstu', 'xoxp-1234-5678-abcdefgh', 'AKIAIOSFODNN7EXAMPLE', 'glpat-abcdefghijklmnop', 'npm_abcdefghijklmnopqrstuvwxyz']) {
    assert.equal(redactValue(tok), '***', tok);
  }
  assert.ok(looksHighEntropy('Zq8vT3kLmN7pR2sW5xY9bC4d'));
  assert.ok(looksHighEntropy('0123456789abcdef0123456789abcdef'), '32-char hex');
  assert.ok(!looksHighEntropy('@modelcontextprotocol/server-everything'));
  assert.ok(!looksHighEntropy('mcp-server-fetch==2025.4.7'));
  assert.ok(!looksHighEntropy('short1A'));
});

test('--pin: secrets stay byte-exact in the file and never reach the output', async () => {
  const input = JSON.stringify({ mcpServers: {
    a: { command: 'npx', args: ['-y', 'pkg', '--api-key', 'sk-proj-LEAK1234567890abcdefgh', '--header', 'Authorization: Bearer LEAKb'] },
    b: { command: 'npx -y pkg --token=LEAKcmd' },
  } }, null, 2) + '\n';
  const h = makeTree({ '.cursor/mcp.json': input });
  const file = path.join(h, '.cursor', 'mcp.json');
  for (const extra of [['--dry-run'], ['--dry-run', '--show-args'], ['--dry-run', '--json'], ['--dry-run', '--show-args', '--json']]) {
    const r = await run([...base(h), '--pin', ...extra]);
    assert.doesNotMatch(r.stdout + r.stderr, SECRET, extra.join(' '));
  }
  const r = await run([...base(h), '--pin', '--show-args']);
  assert.doesNotMatch(r.stdout + r.stderr, SECRET);
  assert.match(r.stdout, /Pinned 2 entries/);
  const want = input.replace('"pkg",\n', '"pkg@3.2.1",\n').replace('npx -y pkg --token', 'npx -y pkg@3.2.1 --token');
  assert.equal(fs.readFileSync(file, 'utf8'), want, 'only the package tokens changed');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"sk-proj-LEAK1234567890abcdefgh"'), 'secret still in the file, unchanged');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"Authorization: Bearer LEAKb"'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('--token=LEAKcmd'));
});

test('parse errors never echo the offending value', async () => {
  const h = makeTree({ '.codex/config.toml': '[mcp_servers.x]\ncommand = "npx"\nenv = { KEY = sk-LEAKunquoted12345678 }\n' });
  const r = await run([...base(h)]);
  assert.match(r.stderr, /config\.toml:3:\d+/);
  assert.doesNotMatch(r.stdout + r.stderr, SECRET);
});
