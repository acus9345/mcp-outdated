// Turn an MCP server entry ({command, args, url, ...}) into a package reference.
//
// Safety rule: if a launcher flag we don't know might swallow the next word,
// we cannot tell which word is the package. Such entries resolve to
// kind "unknown" and are never pinned.
import fs from 'node:fs';
import { isUnsafeName, splitCommand } from './redact.js';

export { splitCommand };

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const PY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SEMVER_EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PY_VERSION = /^v?(?:\d+!)?\d+(?:\.\d+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)?(?:-\d+|[-_.]?(?:post|rev|r)[-_.]?\d*)?(?:[-_.]?dev[-_.]?\d*)?(?:\+[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)?$/i;
const NOT_REGISTRY = /^(?:file:|link:|git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|ssh:|\.{1,2}[\\/]|[\\/~]|[A-Za-z]:[\\/])/;
const LOCAL_PATH = /^(?:file:|link:|\.{1,2}[\\/]|[\\/~]|[A-Za-z]:[\\/])/;
const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export const KNOWN_LAUNCHERS = new Set(['npx', 'bunx', 'bun', 'pnpm', 'yarn', 'npm', 'uvx', 'uv', 'pipx', 'docker', 'podman', 'node', 'python', 'python3', 'py', 'deno', 'cmd']);

// ---- launcher flag tables -------------------------------------------------

const NPM_VALUE = ['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '--globalconfig', '--loglevel', '--node-options', '-w', '--workspace', '--prefix', '--script-shell', '--scope', '--location', '--before', '--fetch-timeout', '--fetch-retries', '--fetch-retry-mintimeout', '--fetch-retry-maxtimeout', '--proxy', '--https-proxy', '--noproxy', '--cafile', '--ca', '--cert', '--key', '--otp', '--omit', '--include', '--install-strategy', '--logs-dir', '--logs-max', '--maxsockets', '--replace-registry-host', '--user-agent'];
const NPM_BOOL = ['-y', '--yes', '--no', '-q', '--quiet', '-s', '--silent', '--verbose', '-d', '-dd', '-ddd', '--no-install', '--ignore-existing', '--prefer-offline', '--prefer-online', '--offline', '--legacy-peer-deps', '--strict-peer-deps', '--foreground-scripts', '--force', '-f', '--timing', '--workspaces', '-ws', '--include-workspace-root', '--global', '-g', '--audit', '--fund', '--update-notifier', '--progress', '--strict-ssl', '--ignore-scripts'];

export const RUNNERS = {
  npx: { valueFlags: NPM_VALUE, boolFlags: NPM_BOOL, packageFlags: ['-p', '--package'] },
  'npm exec': { valueFlags: NPM_VALUE, boolFlags: NPM_BOOL, packageFlags: ['-p', '--package'] },
  bunx: { valueFlags: ['-p', '--package', '--cwd', '--config', '-c'], boolFlags: ['--bun', '--no-install', '--verbose', '--silent', '-y', '--yes'], packageFlags: ['-p', '--package'] },
  'pnpm dlx': { valueFlags: ['--package', '--allow-build', '--reporter', '-C', '--dir', '--cpu', '--os', '--libc', '--registry', '--loglevel', '--config-dir'], boolFlags: ['-c', '--shell-mode', '-s', '--silent', '--verbose', '--prefer-offline', '--offline', '--use-stderr', '--color', '--no-color', '--aggregate-output'], packageFlags: ['--package'] },
  'yarn dlx': { valueFlags: ['-p', '--package'], boolFlags: ['-q', '--quiet'], packageFlags: ['-p', '--package'] },
  uvx: {
    valueFlags: ['--from', '--with', '--with-editable', '--with-requirements', '-w', '-p', '--python', '--index', '--index-url', '-i', '--default-index', '--extra-index-url', '-f', '--find-links', '--env-file', '--directory', '--project', '--config-file', '--cache-dir', '-c', '--constraints', '--overrides', '--build-constraints', '-b', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '--exclude-newer', '--refresh-package', '-P', '--upgrade-package', '--reinstall-package', '--color', '--python-preference', '--link-mode', '--allow-insecure-host', '--no-binary-package', '--no-build-package', '--config-setting', '-C', '--fork-strategy', '--torch-backend'],
    boolFlags: ['-q', '--quiet', '-v', '--verbose', '--isolated', '--no-cache', '-n', '--refresh', '-U', '--upgrade', '--reinstall', '--offline', '--no-config', '--native-tls', '--no-progress', '--managed-python', '--no-managed-python', '--no-python-downloads', '--no-build', '--no-binary', '--no-sources', '--no-build-isolation', '--compile-bytecode', '--no-env-file', '--preview', '--no-preview', '--show-resolution', '--lfs'],
    packageFlags: ['--from'],
  },
  'pipx run': {
    valueFlags: ['--spec', '--python', '--pip-args', '--index-url', '-i', '--backend'],
    boolFlags: ['--no-cache', '--pypackages', '--verbose', '-v', '--quiet', '-q', '--system-site-packages', '--path', '--fetch-missing-python', '--editable', '-e'],
    packageFlags: ['--spec'],
  },
};
RUNNERS['uv tool run'] = RUNNERS.uvx;
RUNNERS['npm x'] = RUNNERS['npm exec'];
RUNNERS['bun x'] = RUNNERS.bunx;

const DOCKER_VALUE_FLAGS = new Set([
  '-e', '--env', '--env-file', '-v', '--volume', '--mount', '--name', '-p', '--publish', '--network', '--net',
  '-w', '--workdir', '-u', '--user', '--entrypoint', '--platform', '-l', '--label', '--label-file', '--add-host',
  '--cpus', '--cpu-shares', '-c', '--cpuset-cpus', '--cpuset-mems', '--memory', '-m', '--memory-swap', '--memory-reservation', '--gpus', '--pull', '--hostname',
  '-h', '--restart', '--cap-add', '--cap-drop', '--device', '--security-opt', '--tmpfs', '--ulimit', '--log-driver',
  '--log-opt', '--runtime', '--ipc', '--pid', '--shm-size', '--dns', '--dns-search', '--dns-option', '--expose',
  '--group-add', '--health-cmd', '--health-interval', '--health-retries', '--health-timeout', '--health-start-period',
  '--isolation', '--link', '--mac-address', '--ip', '--ip6', '--network-alias', '--stop-signal', '--stop-timeout',
  '--storage-opt', '--sysctl', '--userns', '--uts', '--volumes-from', '--cgroupns', '--cgroup-parent', '--cidfile',
  '-a', '--attach', '--detach-keys', '--domainname', '--blkio-weight', '--oom-score-adj', '--pids-limit', '--annotation',
  '--device-cgroup-rule', '--cpu-period', '--cpu-quota', '--cpu-rt-period', '--cpu-rt-runtime', '--kernel-memory', '--memory-swappiness',
]);
const DOCKER_BOOL_FLAGS = new Set(['-i', '--interactive', '-t', '--tty', '-d', '--detach', '--rm', '--init', '--privileged', '--read-only', '-q', '--quiet', '-P', '--publish-all', '--no-healthcheck', '--oom-kill-disable', '--sig-proxy', '--disable-content-trust', '--use-api-socket']);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function launcherName(cmd) {
  const base = String(cmd).split(/[\\/]/).pop().toLowerCase();
  return base.replace(/\.(cmd|exe|bat|ps1|com)$/, '');
}

function commandWords(command, exists) {
  const trimmed = command.trim();
  if (exists(trimmed)) return [{ value: trimmed, start: command.indexOf(trimmed), end: command.indexOf(trimmed) + trimmed.length, raw: trimmed, verified: true }];
  const words = splitCommand(command);
  if (!words.length) return words;
  // Unquoted absolute path containing spaces, e.g. C:\Program Files\nodejs\npx.cmd -y pkg
  if (ABS_PATH.test(words[0].raw) && words[0].raw === words[0].value) {
    for (let k = 0; k < words.length; k++) {
      if (k > 0 && (/^(?:[\\/]|-[A-Za-z-])/.test(words[k].raw))) break;
      const joined = command.slice(words[0].start, words[k].end);
      const onDisk = exists(joined);
      if (onDisk || (k > 0 && KNOWN_LAUNCHERS.has(launcherName(joined)))) {
        if (k === 0) break;
        const merged = { value: joined, start: words[0].start, end: words[k].end, raw: joined, verified: onDisk };
        return [merged, ...words.slice(k + 1)];
      }
    }
    // A path with spaces we can't place: guess it ends at the first word with
    // an executable extension; otherwise keep the whole string as one command
    // (flagged so its tail is never displayed as the launcher name).
    if (!KNOWN_LAUNCHERS.has(launcherName(words[0].value))) {
      for (let k = 0; k < words.length; k++) {
        if (words[k].raw === words[k].value && /\.(exe|cmd|bat|ps1|com)$/i.test(words[k].value)) {
          const joined = command.slice(words[0].start, words[k].end);
          return [{ value: joined, start: words[0].start, end: words[k].end, raw: joined }, ...words.slice(k + 1)];
        }
      }
      return [{ value: trimmed, start: command.indexOf(trimmed), end: command.indexOf(trimmed) + trimmed.length, raw: trimmed, whole: true }];
    }
  }
  return words;
}

function buildArgv(entry, exists) {
  const command = typeof entry.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args.length === 0 && /\s/.test(command.trim())) {
    return commandWords(command, exists).map((w) => ({ value: w.value, whole: !!w.whole, word: !w.whole, verified: !!w.verified, loc: { field: 'command', start: w.start, end: w.end, raw: w.raw } }));
  }
  // Explicit command + args: never split either one for resolution. For
  // display, commandName() still cuts an unverified command at its executable.
  const argv = [{ value: command, verified: /\s/.test(command) ? exists(command.trim()) : true, loc: { field: 'command' } }];
  args.forEach((a, index) => argv.push({ value: typeof a === 'string' ? a : String(a), loc: { field: 'args', index }, nonString: typeof a !== 'string' }));
  return argv;
}

// ---- package token detection ---------------------------------------------

/**
 * Find the package token after a runner's own flags.
 * @returns {{tok, prefix} | {ambiguous: string} | null}
 */
export function findPackage(tokens, { valueFlags, boolFlags = [], packageFlags }) {
  let fromFlag = null;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const v = t.value;
    if (v === '--') {
      if (fromFlag) return fromFlag;
      return tokens[k + 1] ? { tok: tokens[k + 1], prefix: '' } : null;
    }
    if (v.length > 1 && v.startsWith('-')) {
      const eq = v.indexOf('=');
      const flag = eq > 0 ? v.slice(0, eq) : v;
      if (packageFlags.includes(flag)) {
        if (eq > 0) fromFlag = fromFlag || { tok: t, prefix: v.slice(0, eq + 1) };
        else if (tokens[k + 1]) {
          fromFlag = fromFlag || { tok: tokens[k + 1], prefix: '' };
          k++;
        }
        continue;
      }
      if (eq > 0) continue; // --flag=value is self-contained
      if (valueFlags.includes(flag)) {
        k++;
        continue;
      }
      if (boolFlags.includes(flag) || flag.startsWith('--no-')) continue;
      // bundled short booleans: -yq
      if (/^-[A-Za-z]{2,}$/.test(flag) && [...flag.slice(1)].every((c) => boolFlags.includes(`-${c}`))) continue;
      // Unknown flag. Harmless if nothing follows it that it could swallow,
      // or if the package already came from an explicit package flag.
      const next = tokens[k + 1];
      if (fromFlag || !next || (next.value.startsWith('-') && next.value.length > 1)) continue;
      return { ambiguous: flag };
    }
    return fromFlag || { tok: t, prefix: '' };
  }
  return fromFlag;
}

export function parseNpmSpec(raw) {
  let s = raw.trim();
  if (s.startsWith('npm:')) s = s.slice(4);
  if (!s || NOT_REGISTRY.test(s) || s.includes('\\')) return null;
  let name;
  let version;
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
  if (at > 0) {
    name = s.slice(0, at);
    version = s.slice(at + 1);
  } else {
    name = s;
    version = '';
  }
  if (!NPM_NAME.test(name)) return null; // includes github shorthand "user/repo"
  if (/[:/\\?#]/.test(version)) return null;
  return { name, version, pin: classifyNpmVersion(version) };
}

function classifyNpmVersion(v) {
  if (v === '') return 'none';
  if (v === 'latest') return 'latest';
  if (SEMVER_EXACT.test(v)) return 'exact';
  if (/^[A-Za-z][\w.-]*$/.test(v) && !/^v\d/.test(v)) return 'tag';
  return 'range';
}

export function parsePySpec(raw) {
  const s = raw.trim();
  if (!s || NOT_REGISTRY.test(s) || s.includes('://') || s.includes(' @ ')) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m || !PY_NAME.test(m[1])) return null;
  const name = m[1];
  const extras = m[2] || '';
  const rest = m[3].trim();
  if (rest === '') return { name, extras, version: '', pin: 'none' };
  if (rest === '@latest') return { name, extras, version: 'latest', pin: 'latest' };
  let mm;
  if ((mm = /^@(\S+)$/.exec(rest))) {
    if (/[:/\\?#@]/.test(mm[1])) return null;
    return { name, extras, version: mm[1], pin: PY_VERSION.test(mm[1]) ? 'exact' : 'range' };
  }
  if (/[:/\\?#@]/.test(rest)) return null;
  if ((mm = /^===?\s*([^\s,;]+)$/.exec(rest)) && PY_VERSION.test(mm[1])) return { name, extras, version: mm[1], pin: 'exact' };
  if (/^(?:[<>=!~]=?|===)/.test(rest)) return { name, extras, version: rest, pin: 'range' };
  return null;
}

export function parseDockerImage(raw) {
  let image = raw;
  let digest = '';
  const at = image.indexOf('@');
  if (at >= 0) {
    digest = image.slice(at + 1);
    image = image.slice(0, at);
  }
  let tag = '';
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > slash) {
    tag = image.slice(colon + 1);
    image = image.slice(0, colon);
  }
  if (!image || !/^[a-z0-9]/i.test(image)) return null;
  const pin = digest ? 'digest' : tag && tag !== 'latest' ? 'tag' : tag === 'latest' ? 'latest' : 'none';
  return { name: image, tag, digest, pin };
}

export const HIDDEN = '(hidden)';

/** The executable part of an argv[0] token (never its arguments). */
function exeWord(tok) {
  const value = String(tok.value);
  if (tok.verified || tok.word || !/\s/.test(value.trim())) return value;
  const parts = splitCommand(value);
  if (!/:\/\//.test(value) && !parts.slice(1).some((w) => /^(?:[\\/]|-[A-Za-z-])/.test(w.raw)) && KNOWN_LAUNCHERS.has(launcherName(value))) return value;
  const w = commandWords(value, () => false)[0];
  if (!w) return '';
  if (!w.whole) return w.value;
  return parts[0] ? parts[0].value : '';
}

/**
 * Display name for argv[0]. Split on whitespace/quotes FIRST (unless the whole
 * string is a path that exists), then take the basename of that executable
 * word only, so a later argument such as https://hooks.slack.com/.../SECRET can
 * never become the name. A word that is URL-ish or credential-looking yields
 * HIDDEN instead of a name.
 */
export function commandName(tok) {
  const exe = exeWord(tok);
  if (/:\/\/|[?#]/.test(exe)) return HIDDEN;
  const name = launcherName(exe);
  // check the original-case basename: lowercasing hides mixed-case tokens.
  // A verified on-disk path may contain spaces ("run me.exe"); nothing else may.
  const orig = String(exe).split(/[\\/]/).pop();
  const probe = (v) => isUnsafeName(tok.verified ? v.replace(/\s+/g, '-') : v);
  if (!name || probe(name) || probe(orig)) return HIDDEN;
  return name;
}

/**
 * Split one argument that holds a whole command line (cmd /c "npx -y pkg")
 * into tokens whose locations point inside that same JSON/TOML string.
 */
function splitToken(tok, exists) {
  const loc = tok.loc;
  let base = loc.start !== undefined ? loc.start : 0;
  if (loc.start !== undefined && loc.raw !== tok.value) {
    if (loc.raw.length === tok.value.length + 2 && /^(["']).*\1$/s.test(loc.raw)) base += 1;
    else return [tok]; // quoting too complex to map back
  }
  return commandWords(tok.value, exists).map((w) => ({
    value: w.value,
    verified: !!w.verified,
    word: !w.whole,
    nonString: tok.nonString,
    loc: { ...(loc.field === 'args' ? { field: 'args', index: loc.index } : { field: loc.field }), start: base + w.start, end: base + w.end, raw: w.raw },
  }));
}

/** cmd [/s] [/d] [/q] [/e:on] [/v:off] /c|/k <command...> -> the inner argv, or null. */
function unwrapCmd(argv, exists) {
  let k = 1;
  while (argv[k] && /^\/[a-z](?::\S*)?$/i.test(argv[k].value) && !/^\/[ck]$/i.test(argv[k].value)) k++;
  if (!argv[k] || !/^\/[ck]$/i.test(argv[k].value)) return null;
  let rest = argv.slice(k + 1);
  if (rest.length === 1 && /\s/.test(rest[0].value.trim())) rest = splitToken(rest[0], exists);
  return rest;
}

/**
 * The argument list a server is started with (strings, excluding the command),
 * for --show-args. Uses the same splitting rules as resolution.
 */
export function serverArgs(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return [];
  const argv = buildArgv(entry, opts.exists || isFile);
  if (argv[0] && argv[0].whole) return [];
  return argv.slice(1).map((t) => t.value);
}

function local(argv, why) {
  const name = argv[0] ? commandName(argv[0]) : '';
  return { kind: 'local', launcher: name, display: name, reason: why };
}

function unquote(s) {
  const m = /^(["'])(.*)\1$/.exec(s);
  return m ? { inner: m[2], quote: m[1] } : { inner: s, quote: '' };
}

function resolveRunner(launcher, ecosystem, tokens) {
  const found = findPackage(tokens, RUNNERS[launcher]);
  if (!found) return { kind: 'unknown', launcher, reason: 'no package argument' };
  if (found.ambiguous) return { kind: 'unknown', launcher, ecosystem, reason: `unknown ${launcher} option ${found.ambiguous}; cannot tell which argument is the package` };
  const { inner, quote } = unquote(found.tok.value.slice(found.prefix.length));
  const spec = ecosystem === 'npm' ? parseNpmSpec(inner) : parsePySpec(inner);
  if (!spec) {
    if (LOCAL_PATH.test(inner)) return { kind: 'local', launcher, display: launcher, reason: 'local path' };
    return { kind: 'unknown', launcher, ecosystem, raw: inner, reason: 'not a registry package' };
  }
  return {
    kind: 'package',
    launcher,
    ecosystem,
    name: spec.name,
    version: spec.version,
    pin: spec.pin,
    extras: spec.extras || '',
    token: { loc: found.tok.loc, prefix: found.prefix, quote, value: found.tok.value, nonString: !!found.tok.nonString },
  };
}

function resolveDocker(launcher, tokens) {
  for (let k = 0; k < tokens.length; k++) {
    const v = tokens[k].value;
    if (v === '--') continue;
    if (v.length > 1 && v.startsWith('-')) {
      if (v.includes('=')) continue;
      if (DOCKER_VALUE_FLAGS.has(v)) {
        k++;
        continue;
      }
      if (DOCKER_BOOL_FLAGS.has(v) || v.startsWith('--no-')) continue;
      if (/^-[A-Za-z]{2,}$/.test(v) && [...v.slice(1)].every((c) => DOCKER_BOOL_FLAGS.has(`-${c}`))) continue;
      const next = tokens[k + 1];
      if (!next || next.value.startsWith('-')) continue;
      return { kind: 'unknown', launcher, reason: `unknown ${launcher} option ${v}; cannot tell which argument is the image` };
    }
    const img = parseDockerImage(unquote(v).inner);
    if (!img) return { kind: 'unknown', launcher, reason: 'unparseable image' };
    return {
      kind: 'package',
      launcher,
      ecosystem: 'docker',
      name: img.name,
      version: img.digest ? img.digest : img.tag,
      tag: img.tag,
      digest: img.digest,
      pin: img.pin,
      token: { loc: tokens[k].loc, prefix: '', quote: '', value: v },
    };
  }
  return { kind: 'unknown', launcher, reason: 'no image argument' };
}

/**
 * @param {object} entry MCP server entry
 * @param {{exists?: (p: string) => boolean}} [opts] file-existence probe (tests)
 */
export function resolveServer(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return { kind: 'unknown', reason: 'invalid entry' };
  const exists = opts.exists || isFile;
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
  const remoteUrl = (typeof entry.url === 'string' && entry.url) || (typeof entry.serverUrl === 'string' && entry.serverUrl) || '';
  if (remoteUrl || ['http', 'sse', 'streamable-http', 'streamablehttp'].includes(type) || ((typeof entry.url === 'string' || typeof entry.serverUrl === 'string') && typeof entry.command !== 'string')) {
    return { kind: 'remote', launcher: type || 'http', url: remoteUrl };
  }
  let argv = buildArgv(entry, exists);
  if (!argv.length || !argv[0].value) return { kind: 'unknown', reason: 'no command' };
  let name = commandName(argv[0]);
  // Windows wrapper: cmd [/s /d ...] /c npx -y pkg, or cmd /c "npx -y pkg"
  if (name === 'cmd') {
    const inner = unwrapCmd(argv, exists);
    if (inner) {
      if (!inner.length) return { kind: 'unknown', reason: 'empty cmd /c' };
      argv = inner;
      name = commandName(argv[0]);
    }
  }
  const rest = argv.slice(1);
  const sub = rest[0] ? rest[0].value : '';
  switch (name) {
    case 'npx':
    case 'bunx':
      return resolveRunner(name, 'npm', rest);
    case 'pnpm':
    case 'yarn':
      if (sub === 'dlx') return resolveRunner(`${name} dlx`, 'npm', rest.slice(1));
      return local(argv, name);
    case 'npm':
      if (sub === 'exec' || sub === 'x') return resolveRunner(`npm ${sub}`, 'npm', rest.slice(1));
      return local(argv, 'npm');
    case 'bun':
      if (sub === 'x') return resolveRunner('bun x', 'npm', rest.slice(1));
      return local(argv, 'bun');
    case 'uvx':
      return resolveRunner('uvx', 'pypi', rest);
    case 'uv':
      if (sub === 'tool' && rest[1] && rest[1].value === 'run') return resolveRunner('uv tool run', 'pypi', rest.slice(2));
      return local(argv, 'uv');
    case 'pipx':
      if (sub === 'run') return resolveRunner('pipx run', 'pypi', rest.slice(1));
      return local(argv, 'pipx');
    case 'docker':
    case 'podman': {
      let k = 0;
      if (sub === 'container') k = 1;
      if (rest[k] && rest[k].value === 'run') return resolveDocker(name, rest.slice(k + 1));
      return local(argv, name);
    }
    default:
      return local(argv, name);
  }
}
