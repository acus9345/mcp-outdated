// Keep secrets out of everything mcp-outdated prints.

const SECRET_CONTAINER = /^(env|environment|headers|http_headers|env_http_headers|secrets?)$/i;
// `auth` only as a whole word part (auth, x-auth, auth_token, authorization), never author/authority.
const AUTH = 'auth(?:orization|entication|token|[-_]?key)?(?![a-z])';
const SECRET_KEY = new RegExp(`(token|secret|passw(or)?d|api[_-]?key|apikey|${AUTH}|credential|private[_-]?key|cookie|session)`, 'i');
const SECRET_VALUE = /^(?:sk-|sk_|pk_|rk_|whsec_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[a-z]-|xapp-|glpat-|AKIA|ASIA|AIza|ya29\.|Bearer\s|eyJ)/;

/** True if the value at this path (inside a config document) may be a secret. */
export function isSecretPath(path, value) {
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg !== 'string') continue;
    if (SECRET_CONTAINER.test(seg)) return true;
    if (i === path.length - 1 && SECRET_KEY.test(seg)) return true;
  }
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return true;
    // --api-key=..., --token=...
    if (new RegExp(`^--?[\\w-]*(token|secret|key|password|${AUTH})[\\w-]*=`, 'i').test(value)) return true;
  }
  return false;
}

/** Strip credentials, query strings and fragments from a URL-ish string. */
export function redactUrl(s) {
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return s.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '');
  }
}

/** Remote server display: origin only (paths and queries can embed tokens). */
export function urlOrigin(s) {
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid url)';
  }
}

export function redactSpec(s) {
  if (typeof s !== 'string') return '';
  if (SECRET_VALUE.test(s)) return '[redacted]';
  if (/:\/\//.test(s) || /^git\+/.test(s)) return redactUrl(s.replace(/^git\+/, ''));
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

// ---- argument redaction (only used with --show-args) ---------------------

export const MASK = '***';
const SECRET_FLAG = new RegExp(`key|token|secret|pass(word)?|${AUTH}|bearer|credential|api[-_]?key|cookie|session`, 'i');
const SECRET_SHORT_FLAGS = new Set(['-k']);
const HEADER_FLAGS = new Set(['-H', '--header', '--headers', '--http-header']);
// sk_live_/sk_test_/rk_live_/pk_live_ (Stripe) are covered by sk_/rk_/pk_.
const TOKEN_PREFIX = /^(?:sk-|sk_|pk_|rk_|whsec_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[a-z]-|xapp-|glpat-|AKIA|ASIA|AIza|ya29\.|eyJ|npm_|pypi-|hf_|shpat_|SG\.|sq0)/;
const SECRET_HEADER = new RegExp(`^(?:authorization|proxy-authorization|cookie|set-cookie|[\\w-]*(?:key|token|secret|${AUTH})[\\w-]*)$`, 'i');

/** Long, mixed-class strings that look like generated credentials. */
export function looksHighEntropy(s) {
  if (s.length < 24 || /[\s/\\]/.test(s)) return false;
  const lower = /[a-z]/.test(s);
  const upper = /[A-Z]/.test(s);
  const digit = /\d/.test(s);
  const classes = lower + upper + digit;
  if (classes >= 3) return true;
  // hex / base32 style keys: letters + digits, long
  return classes === 2 && digit && s.length >= 32 && /^[A-Za-z0-9_+=-]+$/.test(s);
}

export function looksLikeToken(s) {
  if (typeof s !== 'string') return false;
  // known prefixes: sk_live_x... is a credential even when short
  if (/^(?:sk|rk|pk)_(?:live|test)_\w{4,}/.test(s) || /^whsec_\w{4,}/.test(s)) return true;
  return (s.length >= 16 && TOKEN_PREFIX.test(s)) || looksHighEntropy(s);
}

// Incoming-webhook URLs carry their credential in the path.
const WEBHOOK = /\b(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|[\w.-]*\.webhook\.office\.com|outlook\.office(?:365)?\.com\/webhook|chat\.googleapis\.com\/v1\/spaces)\b/i;
const WEBHOOK_URL = /(\b[a-z][a-z0-9+.-]*:\/\/)?((?:hooks\.slack\.com|discord(?:app)?\.com|[\w.-]*\.webhook\.office\.com|outlook\.office(?:365)?\.com|chat\.googleapis\.com))(\/[^\s"']*)/gi;

/**
 * True when a string must never be shown as a package / launcher / name:
 * URLs, query strings, key=value, user@host userinfo, webhooks, or anything
 * the redactor would change.
 */
export function isUnsafeName(s) {
  if (typeof s !== 'string' || s === '') return false;
  if (/:\/\/|[?=#]|\s/.test(s)) return true;
  if (/[^\s/@]+(?::[^\s/@]*)?@[^\s/@]+\.[^\s/@]+/.test(s) && !/^@[\w.-]+\/[\w.-]+(@[\w.+-]*)?$/.test(s)) return true; // user@host, not @scope/name
  if (WEBHOOK.test(s) || SECRET_VALUE.test(s)) return true;
  return redactValue(s) !== s;
}

/** Redact secrets inside one value: URL credentials/queries, token-like words, Bearer values. */
export function redactValue(s) {
  if (typeof s !== 'string' || s === '') return s;
  let out = s
    // URL userinfo: scheme://user:pass@ -> scheme://user:***@ ; scheme://token@ -> scheme://***@
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s:]*)(?::([^/@\s]*))?@/gi, (m, scheme, user, pass) => (pass !== undefined ? `${scheme}${user}:${MASK}@` : `${scheme}${MASK}@`))
    // scheme-less userinfo: alice:pw@host, alice:pw@db, :pw@host:6379. Skip package specs (npm:pkg@1.2.3, jsr:x@next).
    .replace(/(^|[\s"'=,(])([^\s/@:"'=,(]*):([^\s/@]+)@(?=([a-z0-9][a-z0-9.-]*)(?:[:/\s"']|$))/gi, (m, lead, user, pass, host) => {
      if (/^(npm|jsr|pnpm|yarn|bun|file|link|workspace|portal|patch|git(\+\w+)?|github|gitlab|bitbucket)$/i.test(user)) return m;
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && /^(v?\d[\w.+-]*|latest|next|beta|alpha|canary|rc|dev|stable|lts|edge|nightly|experimental|insiders)$/i.test(host)) return m;
      return `${lead}${user}:${MASK}@`;
    })
    // sensitive query / fragment parameters
    .replace(/([?&#;])([^=&#\s]+)=([^&#\s]*)/g, (m, sep, name, val) => (SECRET_FLAG.test(name) || looksLikeToken(val) ? `${sep}${name}=${MASK}` : m))
    // "Bearer xyz", "Basic xyz", "token xyz"
    .replace(/\b(Bearer|Basic|Token)(\s+)\S+/gi, (m, word, sp) => `${word}${sp}${MASK}`)
    // NAME=value pairs with a secret-ish name (env-style)
    .replace(/(^|[\s,])([A-Za-z_][\w.-]*)=(\S+)/g, (m, lead, name, val) => (SECRET_FLAG.test(name) ? `${lead}${name}=${MASK}` : m))
    // "Header-Name: value" with a secret header name
    .replace(/^([\w-]+)(\s*:\s*)(.+)$/, (m, name, sep) => (SECRET_HEADER.test(name) ? `${name}${sep}${MASK}` : m));
  // webhook URLs: keep the host, drop the path (it is the credential)
  out = out.replace(WEBHOOK_URL, (m, scheme, host, rest) => {
    if (/^discord/i.test(host) && !/^\/api\/webhooks/i.test(rest)) return m;
    if (/^outlook/i.test(host) && !/^\/webhook/i.test(rest)) return m;
    if (/^chat\.googleapis/i.test(host) && !/^\/v1\/spaces/i.test(rest)) return m;
    return `${scheme || ''}${host}/${MASK}`;
  });
  // token-looking words anywhere in the value, including URL path segments
  out = out.replace(/[^\s"'=:,;&?#@/\\]+/g, (w) => (looksLikeToken(w) ? MASK : w));
  return out;
}

function flagName(a) {
  const eq = a.indexOf('=');
  return eq > 0 ? a.slice(0, eq) : a;
}

function isSecretFlag(name) {
  return SECRET_SHORT_FLAGS.has(name) || (name.startsWith('--') && SECRET_FLAG.test(name.slice(2))) || (/^-[A-Za-z][\w-]+$/.test(name) && SECRET_FLAG.test(name.slice(1)));
}

/**
 * Redact a list of command-line arguments for display.
 * --api-key X / --api-key=X / -k X / --header "Authorization: Bearer X" /
 * --header Authorization: Bearer X (split words) all lose the secret part.
 */
/** scheme://host/any/path?x -> scheme://host/*** (paths often embed tokens). */
export function maskUrlPaths(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^/\s"'?#]+)([/?#][^\s"']*)?/gi, (m, origin, rest) => (rest && rest !== '/' ? `${origin}/${MASK}` : m));
}

/**
 * Quote-aware split of a whole command line. Backslashes are literal (Windows
 * paths survive). Each word keeps its raw source span for --pin.
 */
export function splitCommand(str) {
  const words = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i++;
    if (i >= str.length) break;
    const start = i;
    let value = '';
    let quote = null;
    while (i < str.length && (quote || !/\s/.test(str[i]))) {
      const c = str[i];
      if (quote) {
        if (c === quote) quote = null;
        else value += c;
      } else if (c === '"' || c === "'") quote = c;
      else value += c;
      i++;
    }
    words.push({ value, start, end: i, raw: str.slice(start, i), unterminated: !!quote });
  }
  return words;
}

export function redactArgs(args, depth = 0) {
  return redactArgList(args, depth).map(maskUrlPaths);
}

function redactArgList(args, depth) {
  const out = [];
  let maskUntilFlag = false; // after "Authorization:" split across words
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const isFlag = a.length > 1 && a.startsWith('-') && !/^-\d/.test(a);
    if (maskUntilFlag && !isFlag) {
      out.push(MASK);
      continue;
    }
    maskUntilFlag = false;
    if (isFlag) {
      const name = flagName(a);
      const hasEq = a.includes('=');
      if (HEADER_FLAGS.has(name)) {
        const value = hasEq ? a.slice(name.length + 1) : args[i + 1];
        if (value === undefined) {
          out.push(a);
          continue;
        }
        const red = redactHeader(String(value));
        if (hasEq) out.push(`${name}=${red.text}`);
        else {
          out.push(a, red.text);
          i++;
        }
        maskUntilFlag = red.continues;
        continue;
      }
      if (isSecretFlag(name)) {
        if (hasEq) out.push(`${name}=${MASK}`);
        else {
          out.push(a);
          if (i + 1 < args.length) {
            out.push(MASK);
            i++;
          }
        }
        continue;
      }
      out.push(hasEq ? `${name}=${redactValue(a.slice(name.length + 1))}` : a);
      continue;
    }
    // bare "Authorization:" / "Bearer" words (command split into words)
    if (/^[\w-]+:$/.test(a) && SECRET_HEADER.test(a.slice(0, -1))) {
      out.push(a);
      maskUntilFlag = true;
      continue;
    }
    if (/^(bearer|basic|token)$/i.test(a) && i + 1 < args.length) {
      out.push(a, MASK);
      i++;
      continue;
    }
    // One argument holding a whole command line (cmd /c "npx --token X pkg"):
    // redact its words as arguments too, preserving quotes around unchanged parts.
    if (depth === 0 && /\s/.test(a.trim())) {
      const v = redactValue(a);
      const parts = splitCommand(v);
      const words = parts.map((p) => p.value);
      const red = redactArgList(words, 1);
      if (red.some((w, j) => w !== words[j])) {
        out.push(red.map((w, j) => {
          if (w === words[j]) return parts[j].raw;
          const q = parts[j].raw[0];
          return (q === '"' || q === "'") && parts[j].raw.endsWith(q) && /\s/.test(w) ? `${q}${w}${q}` : w;
        }).join(' '));
      } else {
        out.push(v);
      }
      continue;
    }
    out.push(redactValue(a));
  }
  return out;
}

function redactHeader(v) {
  const m = /^([\w-]+)(\s*:\s*)(.*)$/s.exec(v);
  if (!m) return { text: redactValue(v), continues: false };
  if (!SECRET_HEADER.test(m[1])) return { text: `${m[1]}${m[2]}${redactValue(m[3])}`, continues: false };
  // "Authorization:" with the value in the following words
  if (m[3] === '') return { text: v, continues: true };
  return { text: `${m[1]}${m[2]}${MASK}`, continues: false };
}

/** Words of a free-form string (version specs, notes) with token-like words masked. */
export function redactText(s) {
  if (typeof s !== 'string') return s;
  return redactValue(s);
}
