// --pin: rewrite unpinned npx/uvx/... arguments to the exact latest version,
// touching only the bytes of that one string token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathKey } from './errors.js';
import { tomlString } from './toml.js';
import { isSecretPath, redactArgs, redactText } from './redact.js';

const PINNABLE = new Set(['none', 'latest']);

function getAt(doc, p) {
  let v = doc;
  for (const seg of p) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[seg];
  }
  return v;
}

function newSpec(res, latest) {
  const npmPrefix = res.token.value.slice(res.token.prefix.length).startsWith('npm:') ? 'npm:' : '';
  if (res.ecosystem === 'npm') return `${npmPrefix}${res.name}@${latest}`;
  return `${res.name}${res.extras || ''}==${latest}`;
}

/** Rows that --pin would change, plus rows it had to skip and why. */
export function planPins(rows) {
  const targets = [];
  const skipped = [];
  for (const r of rows) {
    if (r.status !== 'unpinned' && r.status !== '@latest') continue;
    const res = r._res;
    const where = `${r.client}/${r.server}`;
    if (res.ecosystem !== 'npm' && res.ecosystem !== 'pypi') {
      skipped.push({ row: r, reason: res.ecosystem === 'docker' ? 'docker images are not pinned automatically' : 'not a registry package' });
      continue;
    }
    if (!PINNABLE.has(res.pin)) {
      skipped.push({ row: r, reason: `version spec "${redactText(res.version)}" is a ${res.pin}; edit it by hand` });
      continue;
    }
    if (!/^\d/.test(r.latest)) {
      skipped.push({ row: r, reason: `latest version unknown (${r.latest || 'not looked up'})` });
      continue;
    }
    if (res.token.nonString) {
      skipped.push({ row: r, reason: 'argument is not a string' });
      continue;
    }
    const q = res.token.quote || '';
    const spec = res.token.prefix + q + newSpec(res, r.latest) + q;
    const target = { row: r, where, from: res.token.value, to: spec };
    const loc = res.token.loc;
    if (loc.start !== undefined) {
      // A word inside a whole-command string (or a cmd /c "..." argument): keep its quoting.
      const wq = loc.raw === res.token.value ? '' : loc.raw.length === res.token.value.length + 2 && /^(["']).*\1$/.test(loc.raw) && loc.raw.slice(1, -1) === res.token.value ? loc.raw[0] : null;
      if (wq === null) {
        skipped.push({ row: r, reason: 'argument quoting is too complex to rewrite safely; edit it by hand' });
        continue;
      }
      target.rawFrom = loc.raw;
      target.rawTo = wq + spec + wq;
    }
    targets.push(target);
  }
  return { targets, skipped };
}

function lineBounds(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end < 0) end = text.length;
  if (end > start && text[end - 1] === '\r') end--;
  return { start, end };
}

/**
 * Compute the new text for one config file. Pure: does not write.
 * @returns {{text: string, changes: object[], errors: string[]}}
 */
export function rewriteConfig(cfg, targets) {
  const edits = [];
  const errors = [];
  for (const t of targets) {
    const res = t.row._res;
    const loc = res.token.loc;
    const strPath = [...t.row._path, loc.field === 'args' ? 'args' : 'command'];
    if (loc.field === 'args') strPath.push(loc.index);
    const span = cfg.spans.get(pathKey(strPath));
    const oldValue = getAt(cfg.doc, strPath);
    if (!span || typeof oldValue !== 'string') {
      errors.push(`${cfg.file}: could not locate ${t.where} argument; skipped`);
      continue;
    }
    let newValue;
    if (loc.start !== undefined) {
      if (oldValue.slice(loc.start, loc.end) !== t.rawFrom) {
        errors.push(`${cfg.file}: ${t.where} changed on disk; skipped`);
        continue;
      }
      newValue = oldValue.slice(0, loc.start) + t.rawTo + oldValue.slice(loc.end);
    } else {
      if (oldValue !== t.from) {
        errors.push(`${cfg.file}: ${t.where} changed on disk; skipped`);
        continue;
      }
      newValue = t.to;
    }
    let literal;
    if (span.style === 'json') literal = JSON.stringify(newValue);
    else if (span.style === '"' || span.style === "'") literal = tomlString(newValue, span.style);
    else {
      errors.push(`${cfg.file}: ${t.where} uses a multi-line string; edit it by hand`);
      continue;
    }
    edits.push({ start: span.start, end: span.end, original: cfg.text.slice(span.start, span.end), literal, target: t });
  }
  edits.sort((a, b) => b.start - a.start);
  const text = applyEdits(cfg.text, edits);

  // Line-level diff, with any line that also holds a secret value redacted.
  const secretSpans = [];
  for (const [key, span] of cfg.spans) {
    const p = JSON.parse(key);
    if (isSecretPath(p, getAt(cfg.doc, p))) secretSpans.push(span);
  }
  // Any argument that argument redaction would change also hides its line.
  for (const t of targets) {
    const entry = getAt(cfg.doc, t.row._path);
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.args)) {
      const args = entry.args.map(String);
      const red = redactArgs(args);
      red.forEach((v, i) => {
        const span = cfg.spans.get(pathKey([...t.row._path, 'args', i]));
        if (span && v !== args[i]) secretSpans.push(span);
      });
    }
    if (typeof entry.command === 'string') {
      const words = entry.command.split(/\s+/).filter(Boolean);
      const span = cfg.spans.get(pathKey([...t.row._path, 'command']));
      if (span && redactArgs(words).some((v, i) => v !== words[i])) secretSpans.push(span);
    }
  }
  const byLine = new Map();
  let delta = 0;
  for (const e of [...edits].reverse()) {
    const old = lineBounds(cfg.text, e.start);
    const lineNo = cfg.text.slice(0, e.start).split('\n').length;
    const newStart = old.start + delta;
    delta += e.literal.length - (e.end - e.start);
    const entry = byLine.get(lineNo) || { line: lineNo, servers: [], tokens: [], oldStart: old.start, oldEnd: old.end, newStart };
    entry.servers.push(e.target.row.server);
    entry.tokens.push({ from: e.target.from, to: e.target.to });
    entry.newEnd = old.end + delta;
    byLine.set(lineNo, entry);
  }
  const changes = [];
  for (const entry of byLine.values()) {
    const oldLine = cfg.text.slice(entry.oldStart, entry.oldEnd);
    const newLine = text.slice(entry.newStart, entry.newEnd);
    const secret = secretSpans.some((s) => s.start < entry.oldEnd && s.end > entry.oldStart);
    const tooLong = oldLine.length > 240;
    changes.push({
      line: entry.line,
      servers: entry.servers,
      tokens: entry.tokens,
      redacted: secret || tooLong,
      oldLine: secret || tooLong ? null : oldLine,
      newLine: secret || tooLong ? null : newLine,
    });
  }
  changes.sort((a, b) => a.line - b.line);
  return { text, changes, errors, edits };
}

/** Apply byte-span edits (sorted or not) to a text. */
export function applyEdits(text, edits) {
  for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.literal + text.slice(e.end);
  return text;
}

function backupPath(file) {
  let candidate = `${file}.bak`;
  for (let n = 1; fs.existsSync(candidate); n++) candidate = `${file}.bak.${n}`;
  return candidate;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * rename() with a short retry loop: on Windows an editor, antivirus or the
 * client itself can briefly hold the target open (EPERM/EBUSY/EACCES).
 */
export function renameWithRetry(from, to, { rename = fs.renameSync, sleep = sleepSync, attempts = 10, delayMs = 50 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (!RETRY_CODES.has(e && e.code) || i >= attempts) throw e;
      sleep(delayMs * i);
    }
  }
}

/** Every planned edit's bytes must still be exactly where we found them. */
export function editsStillApply(text, edits) {
  return edits.every((e) => text.slice(e.start, e.end) === e.original);
}

/**
 * Write `text` over `file` atomically: temp file in the same directory, then
 * rename. Symlinks are followed so a linked dotfile stays a link.
 */
export function atomicWrite(file, text, opts = {}) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    /* new file */
  }
  let mode;
  try {
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    /* keep default */
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    if (opts.beforeRename) opts.beforeRename(target);
    renameWithRetry(tmp, target, opts);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

/**
 * Run --pin over the loaded configs.
 * Just before writing, each file is re-read; if any planned token's bytes
 * moved or changed (e.g. Claude Code rewrote ~/.claude.json meanwhile) the
 * file is skipped untouched. Otherwise the edits are applied to the fresh
 * contents, a .bak is taken, and the new text replaces the file atomically.
 * @returns {{files: object[], skipped: object[], errors: string[]}}
 */
export function pinConfigs(configs, rows, { dryRun = false, hooks = {} } = {}) {
  const { targets, skipped } = planPins(rows);
  const files = [];
  const errors = [];
  const pinned = []; // targets actually written to disk
  configs.forEach((cfg, idx) => {
    const mine = targets.filter((t) => t.row._cfgIndex === idx);
    if (!mine.length) return;
    const out = rewriteConfig(cfg, mine);
    errors.push(...out.errors);
    if (!out.changes.length || out.text === cfg.text) return;
    const file = { file: cfg.file, client: cfg.client, changes: out.changes, backup: null, written: false };
    if (!dryRun) {
      try {
        if (hooks.beforeReread) hooks.beforeReread(cfg.file);
        const freshBuf = fs.readFileSync(cfg.file);
        const fresh = freshBuf.toString('utf8');
        if (!editsStillApply(fresh, out.edits)) {
          errors.push(`${cfg.file}: changed during run, re-run`);
          files.push(file);
          return;
        }
        const text = applyEdits(fresh, out.edits);
        if (isReadOnly(cfg.file)) {
          errors.push(`${cfg.file}: file is read-only`);
          files.push(file);
          return;
        }
        const bak = backupPath(cfg.file);
        fs.copyFileSync(cfg.file, bak); // keeps the original's permissions
        if (!fs.readFileSync(bak).equals(freshBuf)) {
          fs.unlinkSync(bak);
          errors.push(`${cfg.file}: changed during run, re-run`);
          files.push(file);
          return;
        }
        file.backup = bak;
        atomicWrite(cfg.file, text, {
          beforeRename: (target) => {
            if (hooks.beforeRename) hooks.beforeRename(target);
            // last-moment check: abort if the file moved under us again
            if (!fs.readFileSync(target).equals(freshBuf)) {
              const err = new Error('changed during run, re-run');
              err.code = 'CHANGED';
              throw err;
            }
          },
          rename: hooks.rename,
          sleep: hooks.sleep,
        });
        file.written = true;
        for (const e of out.edits) pinned.push(e.target);
      } catch (e) {
        if (e && e.code === 'CHANGED') {
          if (file.backup) fs.rmSync(file.backup, { force: true });
          errors.push(`${cfg.file}: changed during run, re-run`);
          files.push(file);
          return;
        }
        // Nothing was written, so a backup would only be a stray copy of the config.
        if (file.backup) fs.rmSync(file.backup, { force: true });
        file.backup = null;
        errors.push(`${cfg.file}: could not write (${(e && e.code) || (e && e.message)})`);
      }
    }
    files.push(file);
  });
  return { files, skipped, errors, pinned };
}

/**
 * True when the config can't be written: no write bit in its mode (this is how
 * Node reports the Windows read-only attribute) or access(W_OK) fails. Checked
 * before the backup so a read-only file fails fast, without rename retries.
 */
export function isReadOnly(file) {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* keep file */ }
  try {
    if ((fs.statSync(target).mode & 0o222) === 0) return true;
    fs.accessSync(target, fs.constants.W_OK);
    return false;
  } catch (e) {
    return !!(e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS'));
  }
}

/**
 * After a real (non-dry-run) --pin, the rows for entries that were written now
 * reflect the file on disk: pinned to the latest version, status ok. --ci then
 * judges the post-pin state.
 */
export function applyPinned(pinned) {
  for (const t of pinned) {
    const row = t.row;
    if (!row || !row.latest || row.latest === '-') continue;
    Object.assign(row, { current: row.latest, pinType: 'exact', status: 'ok', note: 'pinned by --pin' });
  }
}
