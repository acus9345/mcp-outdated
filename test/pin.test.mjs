import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRegistry, makeTree, copyFixture, run } from './helpers.mjs';

let reg;
before(async () => {
  reg = await startRegistry();
});
after(() => reg.close());

const pinArgs = (home, project, extra = []) => ['--home', home, '--project', project, '--npm-registry', reg.url, '--pypi-url', reg.url, '--pin', ...extra];
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const CURSOR_IN = `{
\t"mcpServers": {
\t\t"fs": {
\t\t\t"command": "npx",
\t\t\t"args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
\t\t},
\t\t"mem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory@latest"]},
\t\t"fetch": {
\t\t\t"command": "uvx",
\t\t\t"args": [
\t\t\t\t"mcp-server-fetch"
\t\t\t]
\t\t},
\t\t"range": {"command": "npx", "args": ["pkg@^1.0.0"]},
\t\t"pinned": {"command": "npx", "args": ["pkg@3.2.1"]},
\t\t"docker": {"command": "docker", "args": ["run", "-i", "mcp/fetch"]}
\t}
}
`;
const CURSOR_OUT = `{
\t"mcpServers": {
\t\t"fs": {
\t\t\t"command": "npx",
\t\t\t"args": ["-y", "@modelcontextprotocol/server-filesystem@2.1.0", "/tmp"]
\t\t},
\t\t"mem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory@2026.8.1"]},
\t\t"fetch": {
\t\t\t"command": "uvx",
\t\t\t"args": [
\t\t\t\t"mcp-server-fetch==2025.4.7"
\t\t\t]
\t\t},
\t\t"range": {"command": "npx", "args": ["pkg@^1.0.0"]},
\t\t"pinned": {"command": "npx", "args": ["pkg@3.2.1"]},
\t\t"docker": {"command": "docker", "args": ["run", "-i", "mcp/fetch"]}
\t}
}
`;

test('pin rewrites only the package tokens (byte-exact), backs up, and is idempotent', async () => {
  const home = makeTree({ '.cursor/mcp.json': CURSOR_IN });
  const project = makeTree({});
  const file = path.join(home, '.cursor', 'mcp.json');
  const r = await run(pinArgs(home, project));
  assert.equal(r.code, 0);
  assert.equal(read(file), CURSOR_OUT);
  assert.equal(read(file + '.bak'), CURSOR_IN, 'backup holds the original bytes');
  assert.match(r.stdout, /Pinned 3 entries in 1 file\(s\)\./);
  assert.match(r.stdout, /skipped cursor\/range: version spec "\^1\.0\.0" is a range/);
  assert.match(r.stdout, /skipped cursor\/docker: docker images are not pinned automatically/);
  // default: only the package token is shown, never the rest of the args line
  assert.match(r.stdout, /- "@modelcontextprotocol\/server-filesystem"\n\+ "@modelcontextprotocol\/server-filesystem@2\.1\.0"/);
  assert.doesNotMatch(r.stdout, /"\/tmp"/);

  const again = await run(pinArgs(home, project));
  assert.equal(again.code, 0);
  assert.match(again.stdout, /Nothing to pin\./);
  assert.equal(read(file), CURSOR_OUT);
  assert.ok(!fs.existsSync(file + '.bak.1'), 'no extra backup when nothing changes');
});

test('--dry-run shows the diff and writes nothing', async () => {
  const home = makeTree({ '.cursor/mcp.json': CURSOR_IN });
  const file = path.join(home, '.cursor', 'mcp.json');
  const r = await run(['--home', home, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--dry-run']);
  assert.equal(r.code, 0);
  assert.equal(read(file), CURSOR_IN);
  assert.ok(!fs.existsSync(file + '.bak'));
  assert.match(r.stdout, /\+\+\+ ~[\\/]\.cursor[\\/]mcp\.json \(dry run\)/);
  assert.match(r.stdout, /@@ line 11 \(fetch\) @@\n- "mcp-server-fetch"\n\+ "mcp-server-fetch==2025\.4\.7"/);
  assert.match(r.stdout, /Would pin 3 entries/);
  // --show-args: whole (redaction-checked) lines
  const full = await run(['--home', home, '--project', makeTree({}), '--npm-registry', reg.url, '--pypi-url', reg.url, '--dry-run', '--show-args']);
  assert.match(full.stdout, /@@ line 11 \(fetch\) @@\n-\t\t\t\t"mcp-server-fetch"\n\+\t\t\t\t"mcp-server-fetch==2025\.4\.7"/);
  assert.match(full.stdout, /-\t\t\t"args": \["-y", "@modelcontextprotocol\/server-filesystem", "\/tmp"\]/);
  assert.match(full.stdout, /\+\t\t\t"args": \["-y", "@modelcontextprotocol\/server-filesystem@2\.1\.0", "\/tmp"\]/);
  assert.equal(read(file), CURSOR_IN);
});

test('pin TOML (Codex): keeps quote style, comments and --from form', async () => {
  const input = [
    '# my codex config',
    'model = "o3"',
    '',
    '[mcp_servers.git]',
    'command = "uvx"',
    "args = ['--from', 'mcp-server-git', 'mcp-server-git']  # keep me",
    '',
    '[mcp_servers.ctx]',
    'command = "npx"',
    'args = [',
    '  "-y",',
    '  "@upstash/context7-mcp@latest",',
    ']',
    'env = { CONTEXT7_API_KEY = "ctx7_SECRET" }',
    '',
  ].join('\n');
  const expected = input
    .replace("'--from', 'mcp-server-git',", "'--from', 'mcp-server-git==2026.1.14',")
    .replace('"@upstash/context7-mcp@latest"', '"@upstash/context7-mcp@1.0.30"');
  const home = makeTree({ '.codex/config.toml': input });
  const r = await run(pinArgs(home, makeTree({})));
  assert.equal(r.code, 0);
  assert.equal(read(home, '.codex', 'config.toml'), expected);
  assert.doesNotMatch(r.stdout, /ctx7_SECRET/);
  const again = await run(pinArgs(home, makeTree({})));
  assert.match(again.stdout, /Nothing to pin/);
});

test('pin a command-string entry and an --package= flag', async () => {
  const input = '{"mcpServers": {"a": {"command": "npx -y pkg --verbose"}, "b": {"command": "npx", "args": ["--package=pkg@latest", "pkg-bin"]}}}\n';
  const home = makeTree({ '.cursor/mcp.json': input });
  await run(pinArgs(home, makeTree({})));
  assert.equal(read(home, '.cursor', 'mcp.json'), '{"mcpServers": {"a": {"command": "npx -y pkg@3.2.1 --verbose"}, "b": {"command": "npx", "args": ["--package=pkg@3.2.1", "pkg-bin"]}}}\n');
});

test('diff lines that also hold env values are redacted', async () => {
  const input = '{"mcpServers": {"s": {"command": "npx", "args": ["-y", "pkg"], "env": {"API_KEY": "sk-live-SECRET123"}}}}\n';
  const home = makeTree({ '.cursor/mcp.json': input });
  const r = await run(pinArgs(home, makeTree({}), ['--dry-run']));
  assert.doesNotMatch(r.stdout, /SECRET123/);
  assert.match(r.stdout, /- "pkg"\n\+ "pkg@3\.2\.1"\n/);
  const sa = await run(pinArgs(home, makeTree({}), ['--dry-run', '--show-args']));
  assert.doesNotMatch(sa.stdout, /SECRET123/);
  assert.match(sa.stdout, /- "pkg"\n\+ "pkg@3\.2\.1"\n  \(line not shown/);
  const j = await run(pinArgs(home, makeTree({}), ['--dry-run', '--json']));
  assert.doesNotMatch(j.stdout, /SECRET123/);
  assert.deepEqual(JSON.parse(j.stdout).pin.files[0].changes[0].tokens, [{ from: 'pkg', to: 'pkg@3.2.1' }]);
});

test('pin preserves CRLF line endings and a BOM', async () => {
  const input = '\ufeff{\r\n  "mcpServers": {\r\n    "s": { "command": "uvx", "args": ["mcp-server-time"] }\r\n  }\r\n}\r\n';
  const home = makeTree({ '.cursor/mcp.json': input });
  await run(pinArgs(home, makeTree({})));
  assert.equal(read(home, '.cursor', 'mcp.json'), input.replace('"mcp-server-time"', '"mcp-server-time==2.0.0"'));
});

test('pin inside ~/.claude.json project scope and the fixture home', async () => {
  const home = copyFixture('home');
  const project = copyFixture('project');
  const r = await run(pinArgs(home, project));
  assert.equal(r.code, 0);
  const desktop = read(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  assert.match(desktop, /"@modelcontextprotocol\/server-filesystem@2\.1\.0",\n        "\/Users\/me\/Desktop"/);
  assert.match(read(home, '.claude.json'), /"@modelcontextprotocol\/server-memory@2026\.8\.1"/);
  assert.match(read(home, '.claude.json'), /"@sentry\/mcp-server@0\.9\.0"/, 'outdated pins are left alone');
  assert.match(read(home, '.cursor', 'mcp.json'), /"mcp-server-fetch==2025\.4\.7"/);
  assert.match(read(home, '.codex', 'config.toml'), /'@upstash\/context7-mcp@1\.0\.30'/);
  assert.match(read(project, '.vscode', 'mcp.json'), /\/\/ VS Code uses "servers", and allows comments/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  // env values untouched byte-for-byte
  assert.match(read(home, '.claude.json'), /"SENTRY_ACCESS_TOKEN": "sntrys_SECRET_VALUE_123"/);
});

test('existing .bak is never overwritten', async () => {
  const home = makeTree({ '.cursor/mcp.json': CURSOR_IN, '.cursor/mcp.json.bak': 'older backup' });
  const file = path.join(home, '.cursor', 'mcp.json');
  await run(pinArgs(home, makeTree({})));
  assert.equal(read(file + '.bak'), 'older backup');
  assert.equal(read(file + '.bak.1'), CURSOR_IN);
});

test('--pin --offline pins nothing and says why', async () => {
  const home = makeTree({ '.cursor/mcp.json': CURSOR_IN });
  const r = await run(['--home', home, '--project', makeTree({}), '--offline', '--pin']);
  assert.equal(r.code, 0);
  assert.equal(read(home, '.cursor', 'mcp.json'), CURSOR_IN);
  assert.match(r.stderr, /nothing pinned in --offline mode/);
  assert.match(r.stdout, /Nothing to pin\./);
});

test('--pin when the registry lookup fails leaves the file alone', async () => {
  const home = makeTree({ '.cursor/mcp.json': '{"mcpServers":{"x":{"command":"npx","args":["no-such-pkg"]}}}' });
  const r = await run(pinArgs(home, makeTree({})));
  assert.match(r.stdout, /skipped cursor\/x: latest version unknown \(not found\)/);
  assert.ok(!fs.existsSync(path.join(home, '.cursor', 'mcp.json.bak')));
});
