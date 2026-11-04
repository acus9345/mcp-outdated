// Human-readable output: npm-outdated style table, summary, pin diff.
import os from 'node:os';
import { redactText, MASK } from './redact.js';

const safe = (s) => redactText(String(s));
const safeToken = (s) => (redactText(String(s)) === String(s) ? String(s) : MASK);

const CODES = { red: [31, 39], green: [32, 39], yellow: [33, 39], magenta: [35, 39], gray: [90, 39], bold: [1, 22], cyan: [36, 39], underline: [4, 24] };

export function colorizer(enabled) {
  const c = {};
  for (const [name, [open, close]] of Object.entries(CODES)) c[name] = (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return c;
}

const STATUS_COLOR = { ok: 'green', outdated: 'red', unpinned: 'yellow', '@latest': 'yellow', unknown: 'magenta', local: 'gray', remote: 'gray', pinned: 'cyan' };

export function tildify(file, home = os.homedir()) {
  if (home && (file === home || file.startsWith(home + '/') || file.startsWith(home + '\\'))) return '~' + file.slice(home.length);
  return file;
}

export function renderTable(rows, { color, long = false, home, showArgs = false } = {}) {
  const c = colorizer(color);
  const headers = ['Client', 'Server', 'Package', 'Current', 'Latest', 'Status'];
  if (long) headers.push('Location');
  if (showArgs) headers.push('Args');
  const data = rows.map((r) => {
    const cells = [r.client, r.server, r.package, r.current, r.latest, r.status];
    if (long) cells.push(tildify(r.file, home) + (r.scope ? ` [${r.scope}]` : ''));
    if (showArgs) cells.push((r.args || []).map((a) => (/[\s"']/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' '));
    return cells.map((x) => String(x == null ? '' : x).replace(/[\x00-\x1f\x7f]/g, '?'));
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const pad = (s, i) => s + ' '.repeat(widths[i] - s.length);
  const lines = [headers.map((h, i) => c.underline(pad(h, i))).join('  ').trimEnd()];
  for (let k = 0; k < data.length; k++) {
    const d = data[k];
    const status = rows[k].status;
    const cells = d.map((s, i) => {
      const p = i === d.length - 1 ? s : pad(s, i);
      if (i === 5) return c[STATUS_COLOR[status] || 'gray'](p);
      if (i === 4 && status === 'outdated') return c.green(p);
      if (i === 3 && status === 'outdated') return c.red(p);
      return p;
    });
    lines.push(cells.join('  ').trimEnd());
  }
  return lines.join('\n');
}

export function renderSummary(rows, counts, configCount, { color } = {}) {
  const c = colorizer(color);
  const parts = [];
  for (const [status, n] of Object.entries(counts)) if (n) parts.push(c[STATUS_COLOR[status] || 'gray'](`${n} ${status}`));
  return `${rows.length} server${rows.length === 1 ? '' : 's'} in ${configCount} config file${configCount === 1 ? '' : 's'}${parts.length ? ': ' + parts.join(', ') : ''}`;
}

export function renderPin(result, { color, dryRun, home, showArgs = false } = {}) {
  const c = colorizer(color);
  const out = [];
  for (const f of result.files) {
    const name = tildify(f.file, home);
    const failed = !dryRun && !f.written;
    out.push(c.bold(`--- ${name}`), c.bold(`+++ ${name}${dryRun ? ' (dry run)' : failed ? ' (NOT written)' : ''}`));
    for (const ch of f.changes) {
      out.push(c.cyan(`@@ line ${ch.line} (${ch.servers.map(safe).join(', ')}) @@`));
      if (!showArgs || ch.redacted) {
        // Default: only the package token changes; the rest of the line (other
        // arguments, which may hold secrets) is never printed.
        for (const t of ch.tokens) out.push(c.red(`- ${JSON.stringify(safeToken(t.from))}`), c.green(`+ ${JSON.stringify(safeToken(t.to))}`));
        if (showArgs) out.push(c.gray('  (line not shown: it also contains env/secret values or is very long)'));
      } else {
        out.push(c.red(`-${ch.oldLine}`), c.green(`+${ch.newLine}`));
      }
    }
    if (f.backup) out.push(c.gray(`backup: ${tildify(f.backup, home)}`));
  }
  const count = (files) => files.reduce((a, f) => a + f.changes.reduce((b, ch) => b + ch.tokens.length, 0), 0);
  const entries = (n) => `${n} entr${n === 1 ? 'y' : 'ies'}`;
  if (!result.files.length) out.push('Nothing to pin.');
  else if (dryRun) out.push(`Would pin ${entries(count(result.files))} in ${result.files.length} file(s). Re-run without --dry-run to write.`);
  else {
    // Count only what reached the disk; failed files are reported separately.
    const ok = result.files.filter((f) => f.written);
    const bad = result.files.filter((f) => !f.written);
    out.push(`Pinned ${entries(count(ok))} in ${ok.length} file(s).`);
    if (bad.length) out.push(c.red(`Not written: ${entries(count(bad))} in ${bad.length} file(s) (see warnings).`));
  }
  for (const s of result.skipped) out.push(c.gray(`skipped ${safe(s.row.client)}/${safe(s.row.server)}: ${safe(s.reason)}`));
  return out.join('\n');
}
