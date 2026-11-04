// Build report rows: discover configs -> resolve servers -> look up latest versions.
import os from 'node:os';
import path from 'node:path';
import { candidates, classify, loadConfig } from './discover.js';
import { resolveServer, serverArgs, HIDDEN } from './resolve.js';
import { lookupAll } from './registry.js';
import { compareVersions, isPrerelease } from './version.js';
import { redactSpec, urlOrigin, redactText, redactArgs, looksLikeToken, isUnsafeName, MASK } from './redact.js';

export const STATUSES = ['outdated', 'unpinned', '@latest', 'unknown', 'ok', 'pinned', 'local', 'remote'];

export function loadAll(opts) {
  const home = opts.home ? path.resolve(opts.home) : os.homedir();
  const project = path.resolve(opts.project || process.cwd());
  const env = opts.env || process.env;
  const list = opts.configs && opts.configs.length
    ? opts.configs.map((f) => classify(f))
    : candidates({ home, project, env, homeOverride: !!opts.home });
  const configs = [];
  const warnings = [];
  for (const cand of list) {
    const loaded = loadConfig(cand);
    if (loaded.missing) {
      if (opts.configs && opts.configs.length) warnings.push(`${cand.file}: not found`);
      continue;
    }
    if (!loaded.ok) {
      warnings.push(loaded.warning);
      continue;
    }
    configs.push({ ...cand, ...loaded });
  }
  return { configs, warnings, home, project };
}

function currentLabel(res) {
  if (res.ecosystem === 'docker') {
    if (res.pin === 'digest') return res.digest.length > 19 ? res.digest.slice(0, 19) + '…' : res.digest;
    if (res.pin === 'tag') return res.tag;
    return res.pin === 'latest' ? 'latest' : 'unpinned';
  }
  if (res.pin === 'none') return 'unpinned';
  if (res.pin === 'latest') return 'latest';
  return res.version;
}

export function makeRows(configs) {
  const rows = [];
  configs.forEach((cfg, cfgIndex) => {
    for (const s of cfg.servers) {
      let res = resolveServer(s.entry);
      // A "package name" that looks like a credential is almost certainly a
      // mis-parsed positional secret: never display it or send it to a registry.
      if (res.kind === 'package' && (looksLikeToken(res.name.replace(/^@[^/]+\//, '')) || res.name.split(/[/@:]/).some(looksLikeToken) || isUnsafeName(res.name))) {
        res = { kind: 'unknown', launcher: res.launcher, reason: 'package argument looks like a secret or URL; not shown' };
      }
      const row = {
        client: cfg.client,
        server: s.name,
        file: cfg.file,
        scope: s.scope || null,
        launcher: res.launcher || '',
        ecosystem: res.ecosystem || null,
        package: '',
        current: '',
        latest: '',
        status: 'unknown',
        pinType: res.pin || null,
        note: redactText(res.reason || ''),
        // only printed with --show-args, and always redacted
        args: redactArgs(serverArgs(s.entry)),
        _res: res,
        _path: s.path,
        _cfgIndex: cfgIndex,
      };
      if (res.kind === 'remote') {
        Object.assign(row, { package: urlOrigin(res.url), current: '-', latest: '-', status: 'remote', note: 'remote server, skipped' });
      } else if (res.kind === 'local') {
        Object.assign(row, { package: res.display || res.launcher, current: '-', latest: '-', status: 'local', note: 'local, skipped' });
      } else if (res.kind === 'unknown') {
        const shown = res.raw ? (isUnsafeName(res.raw) ? HIDDEN : redactText(redactSpec(res.raw))) : res.launcher || '-';
        Object.assign(row, { package: shown, current: '-', latest: '-', status: 'unknown' });
      } else {
        row.package = res.name;
        row.current = redactText(currentLabel(res));
        if (res.ecosystem === 'docker') {
          row.latest = '-';
          row.status = res.pin === 'digest' || res.pin === 'tag' ? 'pinned' : 'unpinned';
          row.note = res.pin === 'tag' ? 'docker tag (latest not checked)' : '';
        } else if (res.pin === 'latest') row.status = '@latest';
        else if (res.pin === 'exact') row.status = 'unknown';
        else row.status = 'unpinned';
      }
      rows.push(row);
    }
  });
  return rows;
}

/**
 * Last line of defence before anything is printed (table, --json, --ci,
 * --pin output): every displayed field goes through the redactor, and a
 * package/launcher that still looks like a URL or credential is replaced.
 */
export function sanitizeRows(rows) {
  for (const r of rows) {
    for (const k of ['client', 'server', 'package', 'launcher', 'current', 'latest', 'note']) {
      if (typeof r[k] === 'string') r[k] = redactText(r[k]);
    }
    if (r.status !== 'remote') {
      if (isUnsafeName(r.package) && r.package !== HIDDEN) r.package = HIDDEN;
      if (isUnsafeName(r.launcher) && r.launcher !== HIDDEN) r.launcher = HIDDEN;
    }
  }
  return rows;
}

export async function applyLookups(rows, opts) {
  const needed = rows.filter((r) => r._res.kind === 'package' && (r.ecosystem === 'npm' || r.ecosystem === 'pypi'));
  if (opts.offline) {
    for (const r of needed) r.latest = 'offline';
    return;
  }
  const results = await lookupAll(needed.map((r) => ({ ecosystem: r.ecosystem, name: r.package })), opts);
  for (const r of needed) {
    const look = results.get(`${r.ecosystem}:${r.package}`);
    if (!look || !look.ok) {
      r.latest = look ? look.error : 'lookup failed';
      if (look && look.detail) r.note = redactText(String(look.detail));
      continue;
    }
    // "latest" ignores pre-releases unless the pinned version is itself one.
    let latest = look.version;
    if (r.pinType === 'exact' && look.prerelease && isPrerelease(r._res.version, r.ecosystem)) {
      const c = compareVersions(look.prerelease, latest, r.ecosystem);
      if (c !== null && c > 0) latest = look.prerelease;
    }
    r.latest = latest;
    if (r.pinType === 'exact') {
      const cmp = compareVersions(r._res.version, latest, r.ecosystem);
      r.status = cmp === null ? 'unknown' : cmp < 0 ? 'outdated' : 'ok';
    }
  }
}

export function summarize(rows) {
  const counts = {};
  for (const s of STATUSES) counts[s] = 0;
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

/** Which rows trip --ci for the given --fail-on categories. */
export function failures(rows, failOn) {
  const set = new Set(failOn);
  return rows.filter((r) =>
    (set.has('outdated') && r.status === 'outdated') ||
    (set.has('unpinned') && (r.status === 'unpinned' || r.status === '@latest')) ||
    (set.has('unknown') && r.status === 'unknown'));
}
