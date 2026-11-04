#!/usr/bin/env node
// Opt-in live smoke test against the REAL npm registry and PyPI.
// Not part of `npm test` (which never touches the network). Run with:
//   npm run smoke:live            (uses this checkout)
//   node scripts/live-smoke.mjs <path-to-mcp-outdated-bin>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-outdated.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-outdated-live-'));
const desktopDir = path.join(home, 'Library', 'Application Support', 'Claude');
fs.mkdirSync(desktopDir, { recursive: true });
fs.writeFileSync(path.join(desktopDir, 'claude_desktop_config.json'), JSON.stringify({
  mcpServers: {
    'fs-unpinned': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    'fs-old': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@0.5.0', '/tmp'] },
    fetch: { command: 'uvx', args: ['mcp-server-fetch==0.6.2'] },
    git: { command: 'uvx', args: ['mcp-server-git'] },
  },
}, null, 2) + '\n');

const runBin = (...args) => spawnSync(process.execPath, [bin, '--home', home, '--project', home, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

const table = runBin();
process.stdout.write(table.stdout);
process.stderr.write(table.stderr);
const json = JSON.parse(runBin('--json').stdout);
const by = Object.fromEntries(json.servers.map((s) => [s.server, s]));
const semverish = /^\d+(\.\d+)+/;
const checks = [
  ['fs-unpinned is unpinned with a real latest', by['fs-unpinned'].status === 'unpinned' && semverish.test(by['fs-unpinned'].latest)],
  ['fs-old@0.5.0 is outdated', by['fs-old'].status === 'outdated'],
  ['PyPI fetch==0.6.2 is outdated', by.fetch.status === 'outdated' && semverish.test(by.fetch.latest)],
  ['PyPI git unpinned resolves latest', by.git.status === 'unpinned' && semverish.test(by.git.latest)],
  ['--ci exits 1', runBin('--ci').status === 1],
];
const dry = runBin('--dry-run');
process.stdout.write('\n' + dry.stdout);
checks.push(['--dry-run proposes 2 pins', /Would pin 2 entries/.test(dry.stdout)]);
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
fs.rmSync(home, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
