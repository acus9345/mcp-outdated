import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServer, parseNpmSpec, parsePySpec, parseDockerImage } from '../src/resolve.js';

const pick = (r) => ({ kind: r.kind, launcher: r.launcher, ecosystem: r.ecosystem, name: r.name, version: r.version, pin: r.pin });

const CASES = [
  // npx
  [{ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: '@modelcontextprotocol/server-filesystem', version: '', pin: 'none' }],
  [{ command: 'npx', args: ['--yes', 'mcp-remote@0.1.29', 'https://x.example/mcp'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'mcp-remote', version: '0.1.29', pin: 'exact' }],
  [{ command: 'npx', args: ['-y', '-p', '@scope/pkg@1.2.3', 'pkg-bin', '--flag'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: '@scope/pkg', version: '1.2.3', pin: 'exact' }],
  [{ command: 'npx', args: ['--package=foo@latest', 'foo'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'foo', version: 'latest', pin: 'latest' }],
  [{ command: 'npx', args: ['-y', 'pkg@^1.2.0'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '^1.2.0', pin: 'range' }],
  [{ command: 'npx', args: ['-y', 'pkg@next'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: 'next', pin: 'tag' }],
  [{ command: 'npx', args: ['-y', 'pkg@1.0.0-beta.1'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '1.0.0-beta.1', pin: 'exact' }],
  [{ command: 'npx', args: ['--registry', 'https://r.example', '-y', 'pkg'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '', pin: 'none' }],
  [{ command: 'npx', args: ['-y', '--', 'pkg@2.0.0'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '2.0.0', pin: 'exact' }],
  [{ command: 'npx -y @scope/srv@1.0.0 --port 3' }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: '@scope/srv', version: '1.0.0', pin: 'exact' }],
  [{ command: '/usr/local/bin/npx', args: ['pkg'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '', pin: 'none' }],
  [{ command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'pkg'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '', pin: 'none' }],
  [{ command: 'cmd', args: ['/c', 'npx', '-y', 'pkg@1.0.0'] }, { kind: 'package', launcher: 'npx', ecosystem: 'npm', name: 'pkg', version: '1.0.0', pin: 'exact' }],
  // other npm runners
  [{ command: 'bunx', args: ['pkg@1.0.0'] }, { kind: 'package', launcher: 'bunx', ecosystem: 'npm', name: 'pkg', version: '1.0.0', pin: 'exact' }],
  [{ command: 'bun', args: ['x', 'pkg'] }, { kind: 'package', launcher: 'bun x', ecosystem: 'npm', name: 'pkg', version: '', pin: 'none' }],
  [{ command: 'pnpm', args: ['dlx', '@scope/pkg'] }, { kind: 'package', launcher: 'pnpm dlx', ecosystem: 'npm', name: '@scope/pkg', version: '', pin: 'none' }],
  [{ command: 'pnpm', args: ['--silent', 'dlx', 'pkg'] }, { kind: 'local', launcher: 'pnpm' }],
  [{ command: 'yarn', args: ['dlx', 'pkg@1.0.0'] }, { kind: 'package', launcher: 'yarn dlx', ecosystem: 'npm', name: 'pkg', version: '1.0.0', pin: 'exact' }],
  [{ command: 'npm', args: ['exec', '--yes', '--', 'pkg@latest'] }, { kind: 'package', launcher: 'npm exec', ecosystem: 'npm', name: 'pkg', version: 'latest', pin: 'latest' }],
  // python runners
  [{ command: 'uvx', args: ['mcp-server-fetch'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'mcp-server-fetch', version: '', pin: 'none' }],
  [{ command: 'uvx', args: ['mcp-server-fetch==0.6.2'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'mcp-server-fetch', version: '0.6.2', pin: 'exact' }],
  [{ command: 'uvx', args: ['--from', 'mcp-server-git==0.6.0', 'mcp-server-git', '--repository', '.'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'mcp-server-git', version: '0.6.0', pin: 'exact' }],
  [{ command: 'uvx', args: ['--from=pkg', 'cmd'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'pkg', version: '', pin: 'none' }],
  [{ command: 'uvx', args: ['--python', '3.12', 'pkg@1.2.3'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'pkg', version: '1.2.3', pin: 'exact' }],
  [{ command: 'uvx', args: ['pkg@latest'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'pkg', version: 'latest', pin: 'latest' }],
  [{ command: 'uvx', args: ['pkg[cli]>=1.0'] }, { kind: 'package', launcher: 'uvx', ecosystem: 'pypi', name: 'pkg', version: '>=1.0', pin: 'range' }],
  [{ command: 'uv', args: ['tool', 'run', 'pkg==1.0'] }, { kind: 'package', launcher: 'uv tool run', ecosystem: 'pypi', name: 'pkg', version: '1.0', pin: 'exact' }],
  [{ command: 'uv', args: ['run', 'server.py'] }, { kind: 'local', launcher: 'uv' }],
  [{ command: 'pipx', args: ['run', 'pkg==1.0.0'] }, { kind: 'package', launcher: 'pipx run', ecosystem: 'pypi', name: 'pkg', version: '1.0.0', pin: 'exact' }],
  [{ command: 'pipx', args: ['run', '--spec', 'pkg==2.0', 'bin'] }, { kind: 'package', launcher: 'pipx run', ecosystem: 'pypi', name: 'pkg', version: '2.0', pin: 'exact' }],
  // docker
  [{ command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server'] }, { kind: 'package', launcher: 'docker', ecosystem: 'docker', name: 'ghcr.io/github/github-mcp-server', version: '', pin: 'none' }],
  [{ command: 'docker', args: ['run', '-i', '--rm', '--env=A=b', '-v', '/a:/b', 'mcp/fetch:latest'] }, { kind: 'package', launcher: 'docker', ecosystem: 'docker', name: 'mcp/fetch', version: 'latest', pin: 'latest' }],
  [{ command: 'docker', args: ['run', '-i', 'localhost:5000/img:1.2'] }, { kind: 'package', launcher: 'docker', ecosystem: 'docker', name: 'localhost:5000/img', version: '1.2', pin: 'tag' }],
  [{ command: 'podman', args: ['container', 'run', 'img@sha256:abc'] }, { kind: 'package', launcher: 'podman', ecosystem: 'docker', name: 'img', version: 'sha256:abc', pin: 'digest' }],
  // local / remote / unknown
  [{ command: 'node', args: ['/home/me/server.js'] }, { kind: 'local', launcher: 'node' }],
  [{ command: 'python', args: ['-m', 'my_server'] }, { kind: 'local', launcher: 'python' }],
  [{ command: '/opt/bin/my-mcp' }, { kind: 'local', launcher: 'my-mcp' }],
  [{ command: 'npx', args: ['-y', './local-server'] }, { kind: 'local', launcher: 'npx' }],
  [{ command: 'npx', args: ['-y', 'github:user/repo'] }, { kind: 'unknown', launcher: 'npx', ecosystem: 'npm' }],
  [{ command: 'npx', args: ['-y'] }, { kind: 'unknown', launcher: 'npx' }],
  [{ url: 'https://mcp.example.com/sse' }, { kind: 'remote', launcher: 'http' }],
  [{ type: 'sse', url: 'https://x' }, { kind: 'remote', launcher: 'sse' }],
  [{}, { kind: 'unknown' }],
];

for (const [entry, expected] of CASES) {
  test(`resolve ${JSON.stringify(entry)}`, () => {
    const got = pick(resolveServer(entry));
    for (const k of Object.keys(got)) if (got[k] === undefined) delete got[k];
    assert.deepEqual(got, expected);
  });
}

test('resolve records where the package token lives', () => {
  assert.deepEqual(resolveServer({ command: 'npx', args: ['-y', 'pkg'] }).token, { loc: { field: 'args', index: 1 }, prefix: '', quote: '', value: 'pkg', nonString: false });
  assert.equal(resolveServer({ command: 'npx', args: ['--package=pkg', 'bin'] }).token.prefix, '--package=');
  assert.deepEqual(resolveServer({ command: 'npx -y pkg' }).token.loc, { field: 'command', start: 7, end: 10, raw: 'pkg' });
});

test('npm spec parser edge cases', () => {
  assert.equal(parseNpmSpec('Not Valid'), null);
  assert.equal(parseNpmSpec('https://x/y.tgz'), null);
  assert.deepEqual(parseNpmSpec('npm:@a/b@1.0.0'), { name: '@a/b', version: '1.0.0', pin: 'exact' });
  assert.deepEqual(parseNpmSpec('pkg@1.x'), { name: 'pkg', version: '1.x', pin: 'range' });
});

test('PyPI spec parser edge cases', () => {
  assert.equal(parsePySpec('git+https://github.com/a/b'), null);
  assert.equal(parsePySpec('pkg @ https://x/y.whl'), null);
  assert.deepEqual(parsePySpec('pkg==1.*'), { name: 'pkg', extras: '', version: '==1.*', pin: 'range' });
  assert.deepEqual(parsePySpec('pkg[a,b]==2.0'), { name: 'pkg', extras: '[a,b]', version: '2.0', pin: 'exact' });
  assert.deepEqual(parsePySpec('pkg~=1.4'), { name: 'pkg', extras: '', version: '~=1.4', pin: 'range' });
});

test('docker image parser', () => {
  assert.deepEqual(parseDockerImage('alpine'), { name: 'alpine', tag: '', digest: '', pin: 'none' });
  assert.deepEqual(parseDockerImage('a/b:1@sha256:ff'), { name: 'a/b', tag: '1', digest: 'sha256:ff', pin: 'digest' });
});
