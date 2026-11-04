// Version ordering: SemVer 2.0.0 for npm, PEP 440 for PyPI.

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(v) {
  const m = SEMVER.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBig(a, b) {
  // numeric strings of arbitrary length
  a = a.replace(/^0+(?=\d)/, '');
  b = b.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0.0 precedence (build metadata ignored). null if unparseable. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const d = cmpNum(pa.major, pb.major) || cmpNum(pa.minor, pb.minor) || cmpNum(pa.patch, pb.patch);
  if (d) return d;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length ? -1 : pb.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const c = cmpBig(x, y);
      if (c) return c;
    } else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const PEP440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/;
const PRE_RANK = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

export function parsePep440(v) {
  const m = PEP440.exec(String(v).trim().toLowerCase());
  if (!m) return null;
  const release = m[2].split('.').map((x) => x.replace(/^0+(?=\d)/, ''));
  while (release.length > 1 && release[release.length - 1] === '0') release.pop();
  return {
    epoch: m[1] ? m[1].replace(/^0+(?=\d)/, '') : '0',
    release,
    pre: m[3] ? [PRE_RANK[m[3]], m[4] || '0'] : null,
    post: m[5] !== undefined ? m[5] : m[6] ? m[7] || '0' : null,
    dev: m[8] ? m[9] || '0' : null,
    local: m[10] ? m[10].split(/[-_.]/) : null,
  };
}

/** PEP 440 ordering. null if unparseable. */
export function comparePep440(a, b) {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) return null;
  let d = cmpBig(pa.epoch, pb.epoch);
  if (d) return d;
  for (let i = 0; i < Math.max(pa.release.length, pb.release.length); i++) {
    d = cmpBig(pa.release[i] || '0', pb.release[i] || '0');
    if (d) return d;
  }
  // pre: a dev release of a final (1.0.dev1) sorts before any pre-release of it
  const preKey = (p) => (p.pre ? [1, p.pre[0], p.pre[1]] : p.post === null && p.dev !== null ? [0, 0, '0'] : [2, 0, '0']);
  const ka = preKey(pa);
  const kb = preKey(pb);
  d = cmpNum(ka[0], kb[0]) || cmpNum(ka[1], kb[1]) || cmpBig(ka[2], kb[2]);
  if (d) return d;
  // post: none sorts first
  if (pa.post !== pb.post) {
    if (pa.post === null) return -1;
    if (pb.post === null) return 1;
    d = cmpBig(pa.post, pb.post);
    if (d) return d;
  }
  // dev: none sorts last
  if (pa.dev !== pb.dev) {
    if (pa.dev === null) return 1;
    if (pb.dev === null) return -1;
    d = cmpBig(pa.dev, pb.dev);
    if (d) return d;
  }
  // local: none sorts first; numeric segments beat alphanumeric ones
  if (!pa.local || !pb.local) return pa.local ? 1 : pb.local ? -1 : 0;
  for (let i = 0; i < Math.max(pa.local.length, pb.local.length); i++) {
    const x = pa.local[i];
    const y = pb.local[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) d = cmpBig(x, y);
    else if (xn) d = 1;
    else if (yn) d = -1;
    else d = x < y ? -1 : x > y ? 1 : 0;
    if (d) return d;
  }
  return 0;
}

/**
 * Compare two versions in the given ecosystem. Returns <0, 0, >0, or null if
 * either is unparseable. npm falls back to PEP 440-style ordering for
 * non-semver strings like "1.0".
 */
export function compareVersions(a, b, ecosystem = 'npm') {
  if (ecosystem === 'pypi') return comparePep440(a, b);
  const s = compareSemver(a, b);
  if (s !== null) return s;
  return comparePep440(a, b);
}

export function isPrerelease(v, ecosystem = 'npm') {
  if (ecosystem === 'pypi') {
    const p = parsePep440(v);
    return !!p && (p.pre !== null || p.dev !== null);
  }
  const s = parseSemver(v);
  if (s) return s.pre.length > 0;
  const p = parsePep440(v);
  return !!p && (p.pre !== null || p.dev !== null);
}

/** Highest version in a list; nulls/unparseable ignored. */
export function maxVersion(list, ecosystem) {
  let best = null;
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const valid = ecosystem === 'pypi' ? parsePep440(v) : parseSemver(v) || parsePep440(v);
    if (!valid) continue;
    if (best === null || compareVersions(v, best, ecosystem) > 0) best = v;
  }
  return best;
}
