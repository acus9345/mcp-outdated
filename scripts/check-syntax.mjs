// `npm run lint`: syntax-check every shipped and test source file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [];
for (const dir of ['bin', 'src', 'test', 'scripts']) {
  for (const f of fs.readdirSync(dir)) if (/\.(m?js)$/.test(f)) files.push(path.join(dir, f));
}
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    process.stderr.write(r.stderr);
  }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exitCode = bad ? 1 : 0;
