#!/usr/bin/env node
// Node 18 prints an ExperimentalWarning for global fetch; keep other warnings.
const original = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning' && /fetch/i.test(w.message)) return;
  for (const l of original) l(w);
});

const { main } = await import('../src/cli.js');
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`mcp-outdated: unexpected error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  },
);
