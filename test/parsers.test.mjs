import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc } from '../src/jsonc.js';
import { parseToml, tomlString } from '../src/toml.js';
import { compareVersions } from '../src/version.js';

test('jsonc: comments, trailing commas, BOM, spans', () => {
  const text = '\ufeff// head\n{ /* c */ "a": ["x", 1, true, null, {"b": "y\\"z"},], }';
  const { value, spans } = parseJsonc(text);
  assert.deepEqual(value, { a: ['x', 1, true, null, { b: 'y"z' }] });
  const s = spans.get(JSON.stringify(['a', 4, 'b']));
  assert.equal(text.slice(s.start, s.end), '"y\\"z"');
});

test('jsonc: __proto__ keys never pollute prototypes', () => {
  const { value } = parseJsonc('{"__proto__": {"polluted": true}}');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(value), ['__proto__']);
});

test('jsonc: errors carry line and column', () => {
  for (const [src, line] of [['{\n  "a": tru\n}', 2], ['{"a": "b"', 1], ['{\n"a" 1}', 2], ['', 1], ['{"a":1} x', 1], ['{"a": "x\ny"}', 1]]) {
    assert.throws(() => parseJsonc(src), (e) => e.name === 'ParseError' && e.line === line && e.col > 0, src);
  }
});

test('toml: Codex-style config subset', () => {
  const text = [
    'model = "o3"',
    'approval_policy = \'on-request\'',
    '',
    '[mcp_servers.fs] # trailing comment',
    'command = "npx"',
    'args = [',
    '  "-y", # first',
    "  '@modelcontextprotocol/server-filesystem',",
    '  "C:\\\\Users\\\\me",',
    ']',
    'env = { "API_KEY" = "s3cret", nested.key = 1 }',
    'startup_timeout_ms = 20_000',
    'enabled = true',
    '',
    '[mcp_servers."my server"]',
    "command = 'uvx'",
    'args = ["pkg==1.0"]',
    'when = 1979-05-27T07:32:00Z',
    'note = """',
    'multi',
    'line"""',
    'hex = 0xff',
    'f = -1.5e3',
    '',
    '[[profiles]]',
    'name = "a"',
    '[[profiles]]',
    'name = "b"',
  ].join('\n');
  const { value, spans } = parseToml(text);
  assert.deepEqual(value.mcp_servers.fs, {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me'],
    env: { API_KEY: 's3cret', nested: { key: 1 } },
    startup_timeout_ms: 20000,
    enabled: true,
  });
  assert.equal(value.mcp_servers['my server'].note, 'multi\nline');
  assert.equal(value.mcp_servers['my server'].when, '1979-05-27T07:32:00Z');
  assert.equal(value.mcp_servers['my server'].hex, 255);
  assert.equal(value.mcp_servers['my server'].f, -1500);
  assert.deepEqual(value.profiles, [{ name: 'a' }, { name: 'b' }]);
  const s = spans.get(JSON.stringify(['mcp_servers', 'fs', 'args', 1]));
  assert.equal(text.slice(s.start, s.end), "'@modelcontextprotocol/server-filesystem'");
  assert.equal(s.style, "'");
  const e = spans.get(JSON.stringify(['mcp_servers', 'fs', 'env', 'API_KEY']));
  assert.equal(text.slice(e.start, e.end), '"s3cret"');
});

test('toml: CRLF line endings and escapes', () => {
  const { value } = parseToml('[a]\r\nb = "x\\ty\\u00e9"\r\nc = [1,\r\n 2]\r\n');
  assert.deepEqual(value, { a: { b: 'x\tyé', c: [1, 2] } });
});

test('toml: malformed input reports a line number', () => {
  const cases = [
    ['a = ', 1],
    ['[x]\nb = "unterminated', 2],
    ['[t]\na = 1\n[t]\n', 3],
    ['a = 1\na = 2', 2],
    ['a = 1 2', 1],
    ['[x\n', 1],
    ['a = [1, 2', 1],
    ['k = nope', 1],
  ];
  for (const [src, line] of cases) {
    assert.throws(() => parseToml(src), (e) => e.name === 'ParseError' && e.line === line, JSON.stringify(src));
  }
});

test('toml: string encoder round-trips', () => {
  for (const v of ['plain', 'with "quotes"', 'back\\slash', "it's"]) {
    for (const style of ['"', "'"]) {
      const lit = tomlString(v, style);
      assert.equal(parseToml(`k = ${lit}`).value.k, v);
    }
  }
});

test('version comparison: semver and PEP 440', () => {
  assert.ok(compareVersions('1.2.3', '1.10.0') < 0);
  assert.ok(compareVersions('2026.1.14', '2025.7.1') > 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('0.6.2', '0.6.2.post1') < 0);
  assert.ok(compareVersions('1.0rc1', '1.0') < 0);
  assert.ok(compareVersions('1.0.dev1', '1.0a1') < 0);
  assert.equal(compareVersions('banana', '1.0'), null);
});
