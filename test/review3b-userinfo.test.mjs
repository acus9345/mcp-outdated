import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactValue } from '../src/redact.js';

const cases = [
  ['redis://:pw123@host:6379', 'pw123'],
  ['rediss://:s3cr3t@cache.example.com', 's3cr3t'],
  ['alice:pw@db.example.com', 'pw'],
  ['alice:hunter2@db.example.com:5432/app', 'hunter2'],
  [':onlypass@localhost:6379', 'onlypass'],
  ['--url=bob:pa55@10.0.0.5', 'pa55'],
  ['"carol:letmein@host.internal"', 'letmein'],
  ['alice:pwDB@db', 'pwDB'],
  ['alice:pwPort@db:5432', 'pwPort'],
  ['admin:pwMongo@mongo/admin', 'pwMongo'],
];
for (const [input, secret] of cases) {
  test(`userinfo password redacted: ${input}`, () => {
    const out = redactValue(input);
    assert.ok(!out.includes(secret), `${out} still contains ${secret}`);
    assert.ok(out.includes('***'));
  });
}

const keep = ['@scope/name@1.2.3', 'pkg@latest', 'npm:pkg@1.2.3', 'npm:pkg@latest', 'jsr:@std/path@next', 'npm:@scope/x@^2.0.0', 'git@github.com', 'user@example.com', 'C:\\Tools\\server.exe'];
for (const s of keep) {
  test(`not redacted: ${s}`, () => assert.equal(redactValue(s), s));
}
