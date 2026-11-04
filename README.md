# mcp-outdated

**`npm outdated` for MCP servers:** scans every MCP client config on your machine (Claude Code, Claude Desktop, Cursor, VS Code, Codex) and lists which servers are unpinned or behind the latest **npm and PyPI** release, with a `--ci --fail-on` gate.
**Why it matters:** the usual `npx -y some-mcp-server` or `uvx some-mcp-server` line pulls whatever version is newest every time the client starts. A compromised or broken release reaches your agent, and your tokens, on the next restart, and nobody reviews it.
**How it differs:** [mcp-lock](https://www.npmjs.com/package/@mcpguards/mcp-lock) and [mcplock](https://www.npmjs.com/package/@nkwib/mcplock) keep lockfiles. [dr-mcp](https://inferensys.github.io/dr-mcp/) is a broad audit suite with npm-only drift checks. [mcp-upgrade](https://github.com/GeiserX/mcp-upgrade) is archived. `mcp-outdated` does one job: npm + PyPI checks, a CI gate, and `--pin` that rewrites a single token byte-for-byte. [Details](#how-this-differs)

Zero runtime dependencies · Node 18+ · MIT

## Quick start

```sh
npx mcp-outdated                 # report on every MCP config found
npx mcp-outdated --pin --dry-run # preview pinning unpinned servers to exact versions
npx mcp-outdated --pin           # write the pins (a .bak backup of each file comes first)
npx mcp-outdated --ci            # exit 1 if anything is unpinned or outdated
```

Or install it: `npm install -g mcp-outdated`, then run `mcp-outdated`.

## Example output

This is real output from the live registries (Nov 2026) for a Claude Desktop config with four servers:

```
$ mcp-outdated
Client          Server       Package                                  Current   Latest      Status
claude-desktop  fetch        mcp-server-fetch                         0.6.2     2026.10.28  outdated
claude-desktop  fs-old       @modelcontextprotocol/server-filesystem  0.5.0     2.1.0       outdated
claude-desktop  fs-unpinned  @modelcontextprotocol/server-filesystem  unpinned  2.1.0       unpinned
claude-desktop  git          mcp-server-git                           unpinned  2026.10.28  unpinned

4 servers in 1 config file: 2 outdated, 2 unpinned
```

```
$ mcp-outdated --pin --dry-run
...
--- ~/Library/Application Support/Claude/claude_desktop_config.json
+++ ~/Library/Application Support/Claude/claude_desktop_config.json (dry run)
@@ line 7 (fs-unpinned) @@
-        "@modelcontextprotocol/server-filesystem",
+        "@modelcontextprotocol/server-filesystem@2.1.0",
@@ line 28 (git) @@
-        "mcp-server-git"
+        "mcp-server-git==2026.10.28"
Would pin 2 entries in 1 file(s). Re-run without --dry-run to write.
```

### Statuses

| Status | Meaning |
| --- | --- |
| `ok` | Pinned to an exact version that matches (or is newer than) the latest release |
| `outdated` | Pinned to an exact version older than the latest |
| `unpinned` | No version, a range (`^1.2`, `>=1.0`), or a dist-tag other than `latest`. For Docker: no tag or `:latest` |
| `@latest` | Explicitly `pkg@latest`, which is unpinned too |
| `pinned` | A Docker image pinned to a tag or digest. The latest tag is not checked in v0.1 |
| `local` | A local script or binary (`node ./server.js`, `/usr/local/bin/x`, `npx ./dir`), skipped |
| `remote` | An HTTP/SSE server (`url`). Only the origin is shown, skipped |
| `unknown` | The lookup failed or you are `--offline` (for exact pins), the spec is not a registry package (`github:user/repo`, a git URL), or the launcher has an option mcp-outdated doesn't know that could swallow the package name (`npx --some-new-flag x pkg`). `unknown` rows are never pinned |

"Latest" is the newest stable release: npm's `latest` dist-tag, and for PyPI the newest release that is not a pre-release (`a`/`b`/`rc`/`.dev`) and not fully yanked. If your pin is itself a pre-release (`2.0.0-beta.2`, `3.0rc1`), it is compared with the newest pre-release too. Versions are ordered by SemVer 2.0 for npm and PEP 440 for PyPI (epochs, pre/post/dev releases, local versions).

## Options

| Flag | Description |
| --- | --- |
| `--json` | Machine-readable output: servers, summary, warnings, pin result |
| `--show-args` | Also show each server's arguments, with secrets redacted (hidden by default) |
| `--long` | Add a Location column (the config file, plus the project for `~/.claude.json`) |
| `--ci` | Exit 1 if any server matches `--fail-on` |
| `--fail-on <list>` | Comma list from `outdated`, `unpinned`, `unknown`. Default `unpinned,outdated`. `unpinned` includes `@latest` |
| `--pin` | Rewrite unpinned and `@latest` npm/PyPI entries to the current latest exact version (`pkg@1.2.3`, `pkg==1.2.3`) |
| `--dry-run` | Show the `--pin` diff without writing anything (implies `--pin`) |
| `--offline` | No network calls. Pinning state is still reported |
| `--config <path>` | Scan only this file. Can be repeated. The client is guessed from the path |
| `--home <dir>` | Home directory used for discovery. `~` in the output then means this directory |
| `--project <dir>` | Project directory for `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json`. Default: the current directory |
| `--concurrency <n>` | Parallel registry lookups (default 8) |
| `--timeout <ms>` | Timeout per lookup (default 10000) |
| `--npm-registry <url>` | npm registry (default `https://registry.npmjs.org`, or env `MCP_OUTDATED_NPM_REGISTRY`) |
| `--pypi-url <url>` | PyPI base URL (default `https://pypi.org`, or env `MCP_OUTDATED_PYPI_URL`) |
| `--color` / `--no-color` | Force colours on or off. Default: on only when stdout is a TTY and `NO_COLOR` is unset |
| `-v`, `--version` / `-h`, `--help` | Print the version / print help |

Exit codes: `0` success (the default even when problems are found), `1` when `--ci` finds failures, `2` for a usage error.

With `--ci --pin`, the gate is judged after pinning: entries that `--pin` just wrote count as `ok`, so a successful pin run exits 0 unless something else (an `outdated` pin, an `unknown` entry, a file that could not be written) still matches `--fail-on`. With `--ci --pin --dry-run` nothing is written, so the gate is judged on the files as they are.

## Supported clients

| Client | Files | Key |
| --- | --- | --- |
| Claude Code | `<project>/.mcp.json`, `~/.claude.json` (top level and `projects.<path>`) | `mcpServers` |
| Claude Desktop | macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\` and the Microsoft Store / MSIX location `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` (any package folder with `Claude` in its name, e.g. `Claude_pzs8sxrjxfjjc`, `AnthropicPBC.Claude_fnn82j28hfe8t`), Linux `~/.config/Claude/`, each holding `claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json`, `<project>/.cursor/mcp.json` | `mcpServers` |
| VS Code | `<project>/.vscode/mcp.json` (comments and trailing commas allowed) | `servers` |
| Codex CLI | `~/.codex/config.toml` (or `$CODEX_HOME`) | `[mcp_servers.<name>]` |

Files passed with `--config` can use any of these shapes, and also `mcp.servers`.

## Supported launchers

| Launcher | Forms understood |
| --- | --- |
| npm | `npx [-y\|--yes] [-p pkg] pkg[@ver]`, `--package=pkg`, `bunx`, `bun x`, `pnpm dlx`, `yarn dlx`, `npm exec [--] pkg`, scoped names, `npm:` aliases |
| PyPI | `uvx pkg[==ver]`, `uvx pkg@ver`, `uvx --from pkg==ver cmd`, `uv tool run`, `pipx run [--spec pkg==ver] pkg`, extras `pkg[cli]` |
| Docker | `docker run ... image[:tag][@digest]` and `podman run` (value flags such as `-e`, `-v` and `--name` are skipped) |
| Other | Windows `cmd /c npx ...` wrappers, including switches before `/c` (`cmd /s /c`, `cmd /d /c`) and the one-argument form `cmd /c "npx -y pkg"` (split, and pinned inside that string); `NPX.CMD`, `npx.exe`, `uvx.ps1` and full paths such as `C:\Program Files\nodejs\npx.cmd` (launcher matched by file name, case-insensitive); a whole command in one `command` string when `args` is empty (split with `"`/`'` quoting, backslashes kept literal) |

Launcher options are parsed with per-launcher tables (`--loglevel`, `--registry`, `--cache`, `--userconfig`, `-p/--package`, `-c/--call` for npx and npm exec; `--from`, `--with`, `--python`, `--index-url` for uvx; `--spec`, `--python`, `--pip-args` for pipx; and so on), and `--flag=value` forms are understood. An option that is not in the table and is followed by a bare word makes the row `unknown` instead of guessing.

## Safety

- **Server arguments are hidden by default.** The table, `--json`, `--ci` messages, warnings and the `--pin`/`--dry-run` diff show only the launcher, the package name and its version; the `--pin` diff shows just the package token that changes (`- "pkg"` / `+ "pkg@1.2.3"`). Env values and headers are never printed, and parse errors never echo the offending value. Remote URLs show only their origin, because paths and query strings often carry tokens. A "package" argument that looks like a credential or a URL is reported as `unknown` and is never sent to a registry. For a `local` server only the executable's file name is shown: a whole-command string is split on whitespace and quotes first, so a later argument such as `https://hooks.slack.com/services/…` can never become the displayed name, and a name that still looks like a URL or credential shows as `(hidden)`. As a last pass, every displayed name, version, note, warning and error goes through the redactor.
- **`--show-args` is opt-in and redacted.** It adds an `Args` column (and an `args` array in `--json`) and full lines in the pin diff, with secrets replaced by `***`: values of flags whose name contains key/token/secret/pass(word)/auth/bearer/credential/cookie/session (`--api-key X`, `--token=X`, `-k X`), `--header "Authorization: …"` in any shape (including split across words), URLs cut down to scheme and host, with any password masked (`https://user:***@host/***`; paths and query strings often carry tokens, as in Slack and Discord webhooks), and values that look like tokens (`sk-`, `sk_live_`/`sk_test_`/`rk_live_`, `whsec_`, `ghp_`, `xox*-`, `AKIA`, `glpat-`, `npm_`, JWTs, and strings of 24+ characters mixing letters, digits and case). A diff line holding any redacted value is replaced by the changed token alone. Plain positional words are shown, so leave it off when sharing output.
- The `--pin` file rewrite itself is never redacted: it changes the package token's bytes and nothing else, so your secrets stay exactly as they were in the file.
- **`--pin` changes one string token per server.** It rewrites the package string and nothing else, so indentation, comments, key order, CRLF line endings and the BOM stay byte-for-byte the same. A `<file>.bak` is written first and never overwritten (`.bak.1`, `.bak.2` and so on). Running it again changes nothing. The `.bak` is a full copy of the config, so it holds the same env values and tokens as the original: it keeps the original's permissions, but treat it like the config itself (don't commit or share it, delete it once you've checked the pin).
- **`--pin` is safe against concurrent writers.** Right before writing, each file is read again and every planned token must still be byte-for-byte where it was found; if not (Claude Code rewrites `~/.claude.json` often), the file is skipped with `changed during run, re-run`. The new contents go to a temp file in the same directory and are renamed over the original (retrying briefly on Windows `EPERM`/`EBUSY`), so a crash never leaves a half-written config. Symlinked configs stay symlinks. A read-only config is reported as `file is read-only` up front (no retries), and if a write fails, its `.bak` is removed so no stray copy of the config is left behind.
- On Windows the rename replaces the file rather than editing it in place: the new file gets the directory's default ACL, and the original's creation time, alternate data streams and hard links are not carried over (the `.bak` keeps the original bytes).
- Malformed files produce a `file:line:col` warning and are skipped. The rest of the report still runs.
- No telemetry. The only network calls are GETs to the npm registry and PyPI, and `--offline` turns those off.

## How this differs

| Tool | What it does | How mcp-outdated differs |
| --- | --- | --- |
| [@inferensys/dr-mcp](https://inferensys.github.io/dr-mcp/) ([npm](https://www.npmjs.com/package/@inferensys/dr-mcp), [GitHub](https://github.com/Inferensys/dr-mcp)) | A broad MCP audit suite: context weight, abandoned packages, permissions, usage history, and patch plans with backups | dr-mcp 0.3.0 checks version drift against the npm registry only (no PyPI lookup for `uvx` servers). It has no `--fail-on` style CI gate: its CLI exits 1 only on errors or a missing plan. Its patch plans parse the config and write it back out (`JSON.stringify(doc, null, 2)` for JSON), so comments and custom formatting are lost. mcp-outdated checks npm and PyPI, offers `--ci --fail-on unpinned,outdated`, and `--pin` replaces just the one string token |
| [GeiserX/mcp-upgrade](https://github.com/GeiserX/mcp-upgrade) | A Go tool that checked and upgraded MCP servers in place. Archived in October 2026 (last push Oct 27 2026) | No longer maintained. Its own README now recommends pinning exact versions and bumping them through review, which is the workflow `mcp-outdated --pin` supports |
| [@mcpguards/mcp-lock](https://www.npmjs.com/package/@mcpguards/mcp-lock), [@nkwib/mcplock](https://www.npmjs.com/package/@nkwib/mcplock) | A lockfile with integrity hashes for MCP servers | They lock. mcp-outdated reports what is unpinned or outdated in every client config and pins it in place |
| [mcpwarden](https://github.com/rashedhasan090/mcpwarden), [mcp-config-linter](https://github.com/baronguyen001/mcp-config-linter), [mcp-warden](https://github.com/kirtanbhatt10/mcp-warden) | Offline security linters that flag unpinned `npx`/`uvx` among many rules | They don't look up the latest version and don't pin |

Comparison checked on 4 Nov 2026 against dr-mcp 0.3.0 (its README and published `dist/`) and the mcp-upgrade GitHub repository.

## Limitations (v0.1)

- `--pin` only pins entries with no version or `@latest`. It does not bump an `outdated` pin, and it leaves ranges (`^1.2`, `>=1`) and other dist-tags (`@next`) alone. Edit those by hand after you review the changelog.
- Docker images are reported by tag. There is no registry lookup, and `--pin` does not add digests.
- Private registries and scoped `.npmrc` registries are not read. Use `--npm-registry` for one alternate registry. Auth tokens are not supported.
- Only the configs listed above are discovered automatically: no Windsurf, Cline, Continue or Zed yet. For other JSON files with `mcpServers` or `servers`, pass `--config`.
- The TOML parser covers the subset that Codex uses (tables, arrays of tables, dotted and quoted keys, every string form, arrays, inline tables, numbers, booleans, dates). It is not a full TOML 1.0 validator.
- Compiled launchers and globally installed binaries (`mcp-server-foo` on PATH) show as `local`, because nothing in the config ties them to a registry version.

## Requirements

Node.js 18 or newer (it uses the global `fetch`). No runtime dependencies.

## Development

```sh
npm test            # node --test against a local mock registry; no network
npm run lint        # syntax check
npm run smoke:live  # opt-in: hits the real npm registry and PyPI
```

## License

MIT
