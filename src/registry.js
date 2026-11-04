// Latest-version lookups against the npm registry and PyPI JSON API.
import { compareVersions, isPrerelease, maxVersion } from './version.js';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_PYPI_URL = 'https://pypi.org';

function trimSlash(u) {
  return u.replace(/\/+$/, '');
}

async function getJson(url, headers, timeoutMs, fetchImpl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: ac.signal, redirect: 'follow' });
    if (res.status === 404) {
      // drain body so the socket can be reused
      await res.arrayBuffer().catch(() => {});
      return { status: 404 };
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      return { status: res.status };
    }
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

export function npmUrl(registry, name) {
  // scoped names keep the "@" but encode the slash: @scope%2fname
  return `${trimSlash(registry)}/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
}

export function pypiUrl(base, name) {
  return `${trimSlash(base)}/pypi/${encodeURIComponent(name)}/json`;
}

/**
 * npm: "latest" is the dist-tag; "prerelease" is the highest non-deprecated
 * version overall (used only when the pinned version is a pre-release).
 */
export function pickNpm(body) {
  const latest = body && body['dist-tags'] && body['dist-tags'].latest;
  if (typeof latest !== 'string' || !latest) return null;
  const versions = body.versions && typeof body.versions === 'object' ? Object.keys(body.versions).filter((v) => !(body.versions[v] && body.versions[v].deprecated)) : [];
  const top = maxVersion([latest, ...versions], 'npm');
  return { version: latest, prerelease: top && compareVersions(top, latest, 'npm') > 0 ? top : latest };
}

/**
 * PyPI: compute from `releases`, skipping versions whose files are all yanked
 * (or that have no files). "version" excludes pre/dev releases; "prerelease"
 * includes them. Falls back to info.version.
 */
export function pickPypi(body) {
  const info = body && body.info;
  const fallback = info && typeof info.version === 'string' && info.version ? info.version : null;
  const releases = body && body.releases && typeof body.releases === 'object' ? body.releases : null;
  const live = [];
  if (releases) {
    for (const [v, files] of Object.entries(releases)) {
      if (!Array.isArray(files) || files.length === 0) continue;
      if (files.every((f) => f && f.yanked)) continue;
      live.push(v);
    }
  }
  if (!live.length) return fallback ? { version: fallback, prerelease: fallback } : null;
  const any = maxVersion(live, 'pypi');
  const stable = maxVersion(live.filter((v) => !isPrerelease(v, 'pypi')), 'pypi');
  if (!any) return fallback ? { version: fallback, prerelease: fallback } : null;
  return { version: stable || any, prerelease: any };
}

/**
 * Look up one package. Never throws.
 * @returns {Promise<{ok: true, version: string, prerelease: string} | {ok: false, error: string}>}
 */
export async function lookup(ecosystem, name, opts) {
  const { npmRegistry = DEFAULT_NPM_REGISTRY, pypiUrl: pypi = DEFAULT_PYPI_URL, timeout = 10000, fetchImpl = globalThis.fetch, userAgent } = opts || {};
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'lookup failed', detail: 'fetch unavailable' };
  const headers = { 'user-agent': userAgent || 'mcp-outdated' };
  let url;
  if (ecosystem === 'npm') {
    url = npmUrl(npmRegistry, name);
    headers.accept = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
  } else if (ecosystem === 'pypi') {
    url = pypiUrl(pypi, name);
    headers.accept = 'application/json';
  } else return { ok: false, error: 'unsupported' };
  try {
    const res = await getJson(url, headers, timeout, fetchImpl);
    if (res.status === 404) return { ok: false, error: 'not found' };
    if (!res.body) return { ok: false, error: 'lookup failed', detail: `HTTP ${res.status}` };
    const picked = ecosystem === 'npm' ? pickNpm(res.body) : pickPypi(res.body);
    if (!picked) return { ok: false, error: 'lookup failed', detail: 'no latest version in response' };
    return { ok: true, ...picked };
  } catch (e) {
    const detail = e && e.name === 'AbortError' ? `timeout after ${timeout}ms` : (e && e.cause && e.cause.code) || (e && e.message) || String(e);
    return { ok: false, error: 'lookup failed', detail };
  }
}

/**
 * Look up many packages with bounded concurrency; deduplicates by ecosystem+name.
 * @param {{ecosystem: string, name: string}[]} items
 * @returns {Promise<Map<string, object>>} keyed by `${ecosystem}:${name}`
 */
export async function lookupAll(items, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 8);
  const keys = [...new Set(items.map((x) => `${x.ecosystem}:${x.name}`))];
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < keys.length) {
      const key = keys[next++];
      const sep = key.indexOf(':');
      results.set(key, await lookup(key.slice(0, sep), key.slice(sep + 1), opts));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return results;
}
