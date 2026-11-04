// Shared test helpers (not a test file itself; node --test just runs it harmlessly).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-outdated.js');

export const NPM_LATEST = {
  '@modelcontextprotocol/server-memory': '2026.8.1',
  '@modelcontextprotocol/server-filesystem': '2.1.0',
  '@modelcontextprotocol/server-everything': '1.0.0',
  '@sentry/mcp-server': '0.20.0',
  '@upstash/context7-mcp': '1.0.30',
  '@playwright/mcp': '0.0.41',
  pkg: '3.2.1',
};
export const PYPI_LATEST = {
  'mcp-server-fetch': '2025.4.7',
  'mcp-server-git': '2026.1.14',
  'mcp-server-time': '2.0.0',
};

/**
 * Start a local fake npm registry + PyPI.
 * Values in `npm` are either a latest-version string or
 *   {latest, versions?: string[], deprecated?: string[]}.
 * Values in `pypi` are either an info.version string or
 *   {version, releases: {[v]: 'ok' | 'yanked' | 'nofiles'}}.
 *
 * Every response says `Connection: close` and close() destroys all sockets,
 * so no keep-alive socket can outlive a test (this hung tests on Windows).
 */
export async function startRegistry({ npm = NPM_LATEST, pypi = PYPI_LATEST, hang = [], fail = [], delayMs = 0 } = {}) {
  const requests = [];
  const sockets = new Set();
  let inFlight = 0;
  let maxInFlight = 0;
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, connection: 'close' });
    res.end(body);
  };
  const server = http.createServer(async (req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    requests.push({ url: req.url, accept: req.headers.accept, ua: req.headers['user-agent'] });
    res.on('close', () => inFlight--);
    res.shouldKeepAlive = false;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const url = decodeURIComponent(req.url);
    let m;
    if ((m = /^\/pypi\/([^/]+)\/json$/.exec(url))) {
      const name = m[1];
      if (hang.includes(name)) return; // never answer
      if (fail.includes(name)) return send(res, 500, 'text/plain', 'boom');
      if (!(name in pypi)) return send(res, 404, 'application/json', '{}');
      const d = typeof pypi[name] === 'string' ? { version: pypi[name], releases: {} } : pypi[name];
      const releases = {};
      for (const [v, state] of Object.entries(d.releases || {})) {
        releases[v] = state === 'nofiles' ? [] : [{ filename: `${name}-${v}.tar.gz`, yanked: state === 'yanked' }];
      }
      return send(res, 200, 'application/json', JSON.stringify({ info: { name, version: d.version }, releases }));
    }
    const name = url.slice(1);
    if (hang.includes(name)) return;
    if (fail.includes(name)) return send(res, 500, 'text/plain', 'boom');
    if (!(name in npm)) return send(res, 404, 'application/json', '{"error":"Not found"}');
    const d = typeof npm[name] === 'string' ? { latest: npm[name], versions: [npm[name]] } : npm[name];
    const versions = {};
    for (const v of d.versions || [d.latest]) versions[v] = { name, version: v, ...((d.deprecated || []).includes(v) ? { deprecated: 'old' } : {}) };
    send(res, 200, 'application/vnd.npm.install-v1+json', JSON.stringify({ name, 'dist-tags': { latest: d.latest }, versions }));
  });
  server.keepAliveTimeout = 1;
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    get openSockets() {
      return sockets.size;
    },
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        if (server.closeAllConnections) server.closeAllConnections();
        for (const s of sockets) s.destroy();
      }),
  };
}

/** A URL nothing listens on (simulates no network). */
export async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

export function tmpdir(prefix = 'mcp-outdated-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy a fixture directory tree to a fresh temp dir. */
export function copyFixture(name) {
  const dest = tmpdir();
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

/** Write a set of files ({relPath: content}) under a fresh temp dir. */
export function makeTree(files) {
  const root = tmpdir();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

export function capture({ isTTY = false } = {}) {
  let data = '';
  return { isTTY, write: (s) => { data += s; return true; }, get text() { return data; } };
}

/** Run main() in-process and capture output. */
export async function run(args, { env = {}, isTTY = false } = {}) {
  const { main } = await import('../src/cli.js');
  const stdout = capture({ isTTY });
  const stderr = capture();
  const code = await main(args, { stdout, stderr, env });
  return { code, stdout: stdout.text, stderr: stderr.text };
}
