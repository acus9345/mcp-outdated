// Command-line entry: mcp-outdated [options]
import fs from 'node:fs';
import { loadAll, makeRows, applyLookups, summarize, failures, sanitizeRows } from './check.js';
import { redactText, MASK } from './redact.js';
import { pinConfigs, applyPinned } from './pin.js';
import { renderTable, renderSummary, renderPin, tildify } from './format.js';
import { DEFAULT_NPM_REGISTRY, DEFAULT_PYPI_URL } from './registry.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `mcp-outdated ${VERSION}
npm outdated for the MCP servers in your MCP client configs.

Usage: mcp-outdated [options]

Scans Claude Code (.mcp.json, ~/.claude.json), Claude Desktop, Cursor,
VS Code (.vscode/mcp.json) and Codex (~/.codex/config.toml) configs, resolves
each server's npm / PyPI / Docker package and reports unpinned and outdated ones.

Options:
  --json                 Machine-readable JSON output
  --long                 Add a Location column (config file path)
  --show-args            Also show each server's arguments (secrets redacted)
                         and full lines in the --pin diff. Hidden by default
  --ci                   Exit 1 if anything matches --fail-on. With --pin,
                         judged after pinning (pinned entries count as ok);
                         with --dry-run, judged on the files as they are
  --fail-on <list>       Comma list for --ci: outdated,unpinned,unknown
                         (default: unpinned,outdated; unpinned includes @latest)
  --pin                  Pin unpinned / @latest npm and PyPI entries to the
                         current latest exact version (writes <file>.bak first)
  --dry-run              With --pin: show the diff, write nothing
  --offline              No network; report pinning state only
  --config <path>        Scan this file instead of discovering (repeatable)
  --home <dir>           Use <dir> as the home directory for discovery
  --project <dir>        Project directory for .mcp.json/.cursor/.vscode (default: cwd)
  --concurrency <n>      Parallel registry lookups (default: 8)
  --timeout <ms>         Per-lookup timeout (default: 10000)
  --npm-registry <url>   npm registry (default: ${DEFAULT_NPM_REGISTRY})
  --pypi-url <url>       PyPI base URL (default: ${DEFAULT_PYPI_URL})
  --color / --no-color   Force colors on/off (default: on for a TTY, off if NO_COLOR)
  -v, --version          Print version
  -h, --help             Print this help

Statuses: ok, outdated, unpinned, @latest, pinned (docker tag/digest, not
checked), local (local script/binary, skipped), remote (URL server, skipped),
unknown (lookup failed, offline, or not a registry package).
Server arguments are hidden unless --show-args; env values, headers and
secret-looking arguments are never printed.`;

const VALUE_OPTS = new Set(['--fail-on', '--config', '--home', '--project', '--concurrency', '--timeout', '--npm-registry', '--pypi-url']);
const BOOL_OPTS = new Set(['--json', '--long', '--show-args', '--ci', '--pin', '--dry-run', '--offline', '--color', '--no-color', '--help', '-h', '--version', '-v']);
const FAIL_ON = new Set(['outdated', 'unpinned', 'unknown']);

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { configs: [], failOn: ['unpinned', 'outdated'] };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      val = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUE_OPTS.has(arg)) {
      if (val === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
        val = argv[++i];
      }
      switch (arg) {
        case '--config': o.configs.push(val); break;
        case '--home': o.home = val; break;
        case '--project': o.project = val; break;
        case '--npm-registry': o.npmRegistry = val; break;
        case '--pypi-url': o.pypiUrl = val; break;
        case '--concurrency':
        case '--timeout': {
          const n = Number(val);
          if (!Number.isInteger(n) || n < 1) throw new UsageError(`${arg} must be a positive integer`);
          o[arg === '--timeout' ? 'timeout' : 'concurrency'] = n;
          break;
        }
        case '--fail-on': {
          const list = val.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s === '@latest' || s === 'latest' ? 'unpinned' : s));
          for (const s of list) if (!FAIL_ON.has(s)) throw new UsageError(`--fail-on: unknown category "${s}" (use outdated, unpinned, unknown)`);
          o.failOn = list;
          break;
        }
      }
      continue;
    }
    if (val !== undefined) throw new UsageError(`${arg} does not take a value`);
    if (!BOOL_OPTS.has(arg)) throw new UsageError(`unknown option: ${arg}`);
    switch (arg) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '--json': o.json = true; break;
      case '--long': o.long = true; break;
      case '--ci': o.ci = true; break;
      case '--show-args': o.showArgs = true; break;
      case '--pin': o.pin = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--offline': o.offline = true; break;
      case '--color': o.color = true; break;
      case '--no-color': o.color = false; break;
    }
  }
  return o;
}

function useColor(o, stream, env) {
  if (o.color !== undefined) return o.color;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return !!(stream && stream.isTTY);
}

// a pin token is shown only if the redactor leaves it alone
function safeTok(t) {
  const ok = (v) => typeof v !== 'string' || redactText(v) === v;
  return ok(t.from) && ok(t.to) ? t : { ...t, from: MASK, to: MASK };
}

function publicRow(r, showArgs) {
  const out = {
    client: r.client,
    server: r.server,
    file: r.file,
    scope: r.scope,
    launcher: r.launcher,
    ecosystem: r.ecosystem,
    package: r.package,
    current: r.current,
    latest: r.latest,
    status: r.status,
    pin: r.pinType,
    note: r.note || undefined,
  };
  if (showArgs) out.args = r.args || [];
  return out;
}

/**
 * Run the CLI. Returns the exit code instead of exiting (testable).
 * @param {string[]} argv
 * @param {{stdout?: any, stderr?: any, env?: object, fetchImpl?: Function}} io
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const write = (s) => stdout.write(s + '\n');
  const warn = (s) => stderr.write(s + '\n');

  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      warn(`mcp-outdated: ${redactText(e.message)}\nRun "mcp-outdated --help" for usage.`);
      return 2;
    }
    throw e;
  }
  if (o.help) return write(HELP), 0;
  if (o.version) return write(VERSION), 0;
  if (o.dryRun) o.pin = true;
  const color = useColor(o, stdout, env);

  const { configs, warnings, home } = loadAll({ home: o.home, project: o.project, configs: o.configs, env });
  const rows = makeRows(configs);
  await applyLookups(rows, {
    offline: o.offline,
    npmRegistry: o.npmRegistry || env.MCP_OUTDATED_NPM_REGISTRY || DEFAULT_NPM_REGISTRY,
    pypiUrl: o.pypiUrl || env.MCP_OUTDATED_PYPI_URL || DEFAULT_PYPI_URL,
    concurrency: o.concurrency,
    timeout: o.timeout,
    fetchImpl: io.fetchImpl,
    userAgent: `mcp-outdated/${VERSION}`,
  });
  rows.sort((a, b) => a.client.localeCompare(b.client) || a.file.localeCompare(b.file) || a.server.localeCompare(b.server));

  let pinResult = null;
  if (o.pin) {
    if (o.offline) warnings.push('--pin needs registry lookups; nothing pinned in --offline mode');
    pinResult = pinConfigs(configs, rows, { dryRun: !!o.dryRun });
    warnings.push(...pinResult.errors);
    // --ci after a real --pin judges the files as written; --dry-run changes nothing.
    if (!o.dryRun) applyPinned(pinResult.pinned);
  }

  sanitizeRows(rows);
  for (let i = 0; i < warnings.length; i++) warnings[i] = redactText(String(warnings[i]));
  const counts = summarize(rows);
  const failed = o.ci ? failures(rows, o.failOn) : [];

  if (o.json) {
    const out = {
      version: VERSION,
      configs: configs.map((c) => ({ client: c.client, file: c.file, servers: c.servers.length })),
      servers: rows.map((r) => publicRow(r, o.showArgs)),
      summary: counts,
      warnings,
    };
    if (pinResult) {
      out.pin = {
        dryRun: !!o.dryRun,
        files: pinResult.files.map((f) => ({ file: f.file, backup: f.backup, written: f.written, changes: f.changes.map((ch) => ({ line: ch.line, servers: ch.servers.map(redactText), tokens: ch.tokens.map(safeTok) })) })),
        skipped: pinResult.skipped.map((s) => ({ client: s.row.client, server: s.row.server, file: s.row.file, reason: redactText(s.reason) })),
      };
    }
    if (o.ci) out.ci = { failOn: o.failOn, failed: failed.length };
    write(JSON.stringify(out, null, 2));
  } else {
    for (const w of warnings) warn(`warning: ${tildify(w, home)}`);
    if (!configs.length) {
      write(o.configs.length ? 'No readable MCP config files.' : 'No MCP client config files found. Use --config <path> to point at one.');
    } else if (!rows.length) {
      write(`No MCP servers configured in ${configs.length} config file${configs.length === 1 ? '' : 's'}.`);
    } else {
      write(renderTable(rows, { color, long: o.long, home, showArgs: !!o.showArgs }));
      write('');
      write(renderSummary(rows, counts, configs.length, { color }));
    }
    if (pinResult) {
      write('');
      write(renderPin(pinResult, { color, dryRun: !!o.dryRun, home, showArgs: !!o.showArgs }));
    }
    if (o.ci && failed.length) warn(`mcp-outdated: ${failed.length} server${failed.length === 1 ? '' : 's'} failed --ci (${o.failOn.join(',')})`);
  }
  return failed.length ? 1 : 0;
}
