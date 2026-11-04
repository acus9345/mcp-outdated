import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, deadUrl } from './helpers.mjs';
import { lookup, lookupAll, npmUrl, pypiUrl } from '../src/registry.js';

test('URL building: scoped npm names and PyPI', () => {
  assert.equal(npmUrl('https://registry.npmjs.org/', '@scope/pkg'), 'https://registry.npmjs.org/@scope%2Fpkg');
  assert.equal(npmUrl('https://r.example', 'pkg'), 'https://r.example/pkg');
  assert.equal(pypiUrl('https://pypi.org', 'mcp-server-fetch'), 'https://pypi.org/pypi/mcp-server-fetch/json');
});

test('npm + PyPI lookups against a mock registry', async () => {
  const reg = await startRegistry();
  try {
    const opts = { npmRegistry: reg.url, pypiUrl: reg.url, userAgent: 'mcp-outdated/test' };
    assert.deepEqual(await lookup('npm', '@modelcontextprotocol/server-filesystem', opts), { ok: true, version: '2.1.0', prerelease: '2.1.0' });
    assert.deepEqual(await lookup('pypi', 'mcp-server-fetch', opts), { ok: true, version: '2025.4.7', prerelease: '2025.4.7' });
    assert.deepEqual(await lookup('npm', 'does-not-exist', opts), { ok: false, error: 'not found' });
    const npmReq = reg.requests.find((r) => r.url.includes('server-filesystem'));
    assert.match(npmReq.accept, /application\/vnd\.npm\.install-v1\+json/, 'asks for abbreviated metadata');
    assert.equal(npmReq.ua, 'mcp-outdated/test');
    assert.equal(npmReq.url, '/@modelcontextprotocol%2Fserver-filesystem');
  } finally {
    await reg.close();
  }
});

test('server errors and timeouts become "lookup failed"', async () => {
  const reg = await startRegistry({ hang: ['slow'], fail: ['broken'] });
  try {
    const opts = { npmRegistry: reg.url, pypiUrl: reg.url, timeout: 200 };
    const t0 = Date.now();
    const slow = await lookup('npm', 'slow', opts);
    assert.equal(slow.ok, false);
    assert.equal(slow.error, 'lookup failed');
    assert.match(slow.detail, /timeout/);
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual(await lookup('pypi', 'broken', opts), { ok: false, error: 'lookup failed', detail: 'HTTP 500' });
  } finally {
    await reg.close();
  }
});

test('no network: connection refused becomes "lookup failed"', async () => {
  const url = await deadUrl();
  const r = await lookup('npm', 'pkg', { npmRegistry: url, timeout: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'lookup failed');
});

test('lookupAll dedupes and respects the concurrency limit', async () => {
  const npm = {};
  for (let i = 0; i < 12; i++) npm[`p${i}`] = `1.0.${i}`;
  const reg = await startRegistry({ npm, delayMs: 30 });
  try {
    const items = [];
    for (let i = 0; i < 12; i++) items.push({ ecosystem: 'npm', name: `p${i}` }, { ecosystem: 'npm', name: `p${i}` });
    const res = await lookupAll(items, { npmRegistry: reg.url, concurrency: 3 });
    assert.equal(res.size, 12);
    assert.equal(reg.requests.length, 12);
    assert.ok(reg.maxInFlight <= 3, `max in flight ${reg.maxInFlight}`);
    assert.deepEqual(res.get('npm:p7'), { ok: true, version: '1.0.7', prerelease: '1.0.7' });
  } finally {
    await reg.close();
  }
});
