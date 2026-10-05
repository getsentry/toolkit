---
title: Migrating from v3 (sentry-cli)
description: Upgrade guide from the legacy sentry-cli (v3) to the new sentry CLI (v4), including the sentry-cli → sentry rename, command changes, and copy-paste compatibility shims.
---

Version 4 is a ground-up rewrite of the Sentry CLI. The most visible change is
the name: the tool is now called **`sentry`** (not `sentry-cli`), shipped from
the **`sentry`** npm package (not `@sentry/cli`). Most of your commands keep
working — many old names are kept as hidden aliases — but a handful moved, and
the output/exit-code behavior was modernized.

This guide covers everything that changed and gives you **copy-paste shims** so
existing scripts and muscle memory keep working while you migrate.

:::tip[In a hurry?]
Add the [compatibility shim](#drop-in-compatibility-shim) to your shell profile
and most `sentry-cli …` invocations keep working unchanged. Then migrate at your
own pace.
:::

## What changed at a glance

| Area | v3 (`sentry-cli`) | v4 (`sentry`) |
|------|-------------------|---------------|
| Binary name | `sentry-cli` | `sentry` |
| npm package | `@sentry/cli` | `sentry` |
| Command groups | plural (`releases`, `projects`) | singular (`release`, `project`) |
| Output | plain text | Markdown on a TTY, plain when piped, `--json` for machines |
| Exit codes | mostly `1` | [semantic ranges](/exit-codes/) (auth=1x, input=2x, API=3x…) |
| Auth | token-only | OAuth device flow (`sentry auth login`) **or** token |
| Some commands | `login`, `update`, `upload-dif`, `deploys` | moved (see [table](#command-changes)) |
| Flags | per-command `--auth-token`/`--url`/`--header`/… | `--org`/`--project`/`--log-level`/`-v` kept; others → env vars (see [Global flags](#global-flags-and-options)) |

Your **environment variables** (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
`SENTRY_PROJECT`, `SENTRY_DSN`, `SENTRY_URL`) and your **`.sentryclirc`** file
are still read, so CI credentials keep working as-is.

## Installation

Uninstall the old package/binary and install the new one.

```bash
# npm / pnpm / yarn / bun
npm uninstall -g @sentry/cli
npm install -g sentry            # or: pnpm add -g sentry / yarn global add sentry / bun add -g sentry

# Homebrew
brew uninstall sentry-cli
brew install getsentry/tools/sentry

# Install script
curl https://cli.sentry.dev/install -fsS | bash

# One-off, no install
npx sentry@latest --help
```

Verify:

```bash
sentry --version
sentry auth status
```

## The `sentry-cli` → `sentry` rename

If you only ever call the top-level binary, the simplest bridge is a plain
alias so old commands and scripts resolve to the new binary:

```bash
# ~/.bashrc or ~/.zshrc
alias sentry-cli='sentry'
```

This is enough **if** you only used commands whose names didn't move (see the
[table below](#command-changes)). For the commands that did move, use the
[compatibility shim](#drop-in-compatibility-shim) instead of a plain alias.

For CI, either update your install step to `npm install -g sentry` and call
`sentry`, or add a one-line shim in your job:

```bash
# GitHub Actions / any CI shell
npm install -g sentry
sentry-cli() { sentry "$@"; }   # if you didn't use any moved commands
```

## Command changes

### Still work unchanged

These are identical, or the old plural form still works as a shortcut:

| v3 | v4 |
|----|----|
| `sentry-cli info` | `sentry info` |
| `sentry-cli send-event …` | `sentry send-event …` |
| `sentry-cli bash-hook` | `sentry bash-hook` |
| `sentry-cli sourcemaps …` | `sentry sourcemaps …` (or `sentry sourcemap …`) |
| `sentry-cli debug-files …` | `sentry debug-files …` |
| `sentry-cli react-native gradle` | `sentry react-native gradle` |
| `sentry-cli react-native xcode` | `sentry react-native xcode` |

### Renamed groups (plural → singular)

Command **groups** are singular now. The plural name still works as a shortcut
for the bare **list** (`sentry releases` → lists releases), but any
**subcommand** must use the singular form:

| v3 | v4 |
|----|----|
| `sentry-cli organizations …` | `sentry org …` |
| `sentry-cli projects …` | `sentry project …` |
| `sentry-cli releases …` | `sentry release …` |
| `sentry-cli issues …` | `sentry issue …` |
| `sentry-cli monitors …` | `sentry monitor …` |
| `sentry-cli repos …` | `sentry repo …` |
| `sentry-cli events …` | `sentry event …` |

```bash
# v3
sentry-cli releases new 1.0.0
# v4
sentry release new 1.0.0
```

### Moved commands

These live under a different group now:

| v3 | v4 |
|----|----|
| `sentry-cli login` | `sentry auth login` |
| `sentry-cli logout` | `sentry auth logout` |
| `sentry-cli update` | `sentry cli upgrade` |
| `sentry-cli uninstall` | `sentry cli uninstall` |
| `sentry-cli deploys new …` | `sentry release deploy …` (create) |
| `sentry-cli deploys list …` | `sentry release deploys …` (list) |
| `sentry-cli upload-dif …` | `sentry debug-files upload …` |
| `sentry-cli upload-dsym …` | `sentry debug-files upload …` |
| `sentry-cli difutil check …` | `sentry debug-files check …` |
| `sentry-cli upload-proguard …` | `sentry proguard upload …` |

Most of these were already soft-deprecated in v3 (hidden from `--help` in favor
of `debug-files` / `proguard`); v4 simply drops the legacy top-level spellings.

`sentry-cli send-envelope` also has no direct v4 equivalent. To send an existing
envelope file, use `sentry event send ./envelope-file --raw` and update any v3
flags in the call. The shim below cannot translate `send-envelope` for you.

## Drop-in compatibility shim

Paste this shell function into your `~/.bashrc` / `~/.zshrc` (or a CI step). It
transparently translates every moved/renamed command to its v4 equivalent, so
existing `sentry-cli …` calls keep working. Anything it doesn't special-case is
passed straight through to `sentry`.

```bash
sentry-cli() {
  # v3 GLOBAL flags that became environment variables in v4 (see the "Global
  # flags" section below). They precede the command, so translate only the
  # LEADING run and stop at the first command word — this leaves command-level
  # flags untouched (notably `--url`, which `release create`/`deploy` use for
  # the release/deploy URL, not the Sentry host). Other still-valid v4 globals
  # are collected into `lead` and re-applied before the command.
  local envs=() lead=() headers="" allow_failure="" login_url="" login_args=()
  while [ "$#" -gt 0 ]; do
    case "${1:-}" in
      --auth-token)   envs+=("SENTRY_AUTH_TOKEN=$2" "SENTRY_FORCE_ENV_TOKEN=1"); shift 2 2>/dev/null || shift ;;
      --auth-token=*) envs+=("SENTRY_AUTH_TOKEN=${1#*=}" "SENTRY_FORCE_ENV_TOKEN=1"); shift ;;
      --url)          login_url="$2"; shift 2 2>/dev/null || shift ;;
      --url=*)        login_url="${1#*=}"; shift ;;
      # Multiple --header flags merge into one semicolon-separated var.
      --header)       headers="${headers:+$headers; }$2"; shift 2 2>/dev/null || shift ;;
      --header=*)     headers="${headers:+$headers; }${1#*=}"; shift ;;
      # Still-valid v4 globals: keep them (value-taking ones consume a value).
      --org|--project|--log-level|--fields) lead+=("$1" "$2"); shift 2 2>/dev/null || shift ;;
      --org=*|--project=*|--log-level=*|--fields=*) lead+=("$1"); shift ;;
      -v|--verbose|--json) lead+=("$1"); shift ;;
      # v3 `--allow-failure` (and SENTRY_ALLOW_FAILURE) is gone in v4 and would
      # be rejected as unknown. Strip it and emulate its "never fail" behavior.
      --allow-failure) allow_failure=1; shift ;;
      *)              break ;;
    esac
  done

  # v3 accepts auth, headers and allow-failure after the command too. Keep
  # --url on releases/deploys: there it can name the release or deploy URL.
  local command="${1:-}" remaining=()
  if [ -n "$login_url" ]; then
    if [ "$command" = login ]; then login_args=(--url "$login_url")
    else envs+=("SENTRY_HOST=$login_url" "SENTRY_URL=$login_url"); fi
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --auth-token)
        [ "$#" -ge 2 ] || { remaining+=("$1"); shift; continue; }
        envs+=("SENTRY_AUTH_TOKEN=$2" "SENTRY_FORCE_ENV_TOKEN=1"); shift 2 ;;
      --auth-token=*) envs+=("SENTRY_AUTH_TOKEN=${1#*=}" "SENTRY_FORCE_ENV_TOKEN=1"); shift ;;
      --header)
        [ "$#" -ge 2 ] || { remaining+=("$1"); shift; continue; }
        headers="${headers:+$headers; }$2"; shift 2 ;;
      --header=*) headers="${headers:+$headers; }${1#*=}"; shift ;;
      --allow-failure) allow_failure=1; shift ;;
      --url)
        if [ "$command" = login ] || [ "$command" = releases ] || [ "$command" = deploys ] || [ "$#" -lt 2 ]; then
          remaining+=("$1"); shift
        else
          envs+=("SENTRY_HOST=$2" "SENTRY_URL=$2"); shift 2
        fi ;;
      --url=*)
        if [ "$command" = login ] || [ "$command" = releases ] || [ "$command" = deploys ]; then
          remaining+=("$1")
        else
          envs+=("SENTRY_HOST=${1#*=}" "SENTRY_URL=${1#*=}")
        fi
        shift ;;
      *) remaining+=("$1"); shift ;;
    esac
  done
  set -- "${remaining[@]}"
  [ "${SENTRY_ALLOW_FAILURE:-}" = "1" ] && allow_failure=1
  [ -n "$headers" ] && envs+=("SENTRY_CUSTOM_HEADERS=$headers")

  # `env` runs the real `sentry` (bypassing this function → no recursion),
  # re-applying any leading global flags before the translated command.
  local run=(env "${envs[@]}" sentry "${lead[@]}")

  _scli_set_host() {
    local word inserted="" updated=()
    for word in "${run[@]}"; do
      if [ -z "$inserted" ] && [ "$word" = sentry ]; then
        updated+=("SENTRY_HOST=$1" "SENTRY_URL=$1")
        inserted=1
      fi
      updated+=("$word")
    done
    run=("${updated[@]}")
  }

  # `deploys` handling (top-level or nested under `releases`). Bare/`list` map to
  # `release deploys` (list); only `new` (create) can't be shimmed — v4 takes the
  # environment/name as positionals, not v3's `-e`/`-n` flags — so flag those.
  local deploy_msg='sentry-cli: `deploys new` changed in v4 — environment/name are positionals now:\n  sentry release deploy <version> <environment> [name] [--url … --started … --finished …]\n'
  _scli_deploys() {
    local release="" listed="" dargs=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --url)
          [ "$#" -ge 2 ] || break
          _scli_set_host "$2"; shift 2 ;;
        --url=*) _scli_set_host "${1#*=}"; shift ;;
        *) break ;;
      esac
    done
    while [ "$#" -gt 0 ]; do
      case "$1" in
        list) listed=1; shift ;;
        -r|--release)
          release="${2:-}"
          shift 2 2>/dev/null || shift
          ;;
        --release=*) release="${1#*=}"; shift ;;
        new)
          if [ -z "$listed" ]; then printf '%b' "$deploy_msg" >&2; return 64; fi
          dargs+=("$1"); shift ;;
        *) dargs+=("$1"); shift ;;
      esac
    done
    [ -n "$release" ] && dargs=("$release" "${dargs[@]}")
    "${run[@]}" release deploys "${dargs[@]}"
  }

  _scli_group() {
    local grp="$1"; shift
    # v3 also accepts global flags between a plural group and its subcommand.
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --org|--project|--log-level|--fields)
          [ "$#" -ge 2 ] || break
          run+=("$1" "$2"); shift 2 ;;
        --org=*|--project=*|--log-level=*|--fields=*|-v|--verbose|--json)
          run+=("$1"); shift ;;
        --url)
          [ "$#" -ge 2 ] || break
          _scli_set_host "$2"; shift 2 ;;
        --url=*) _scli_set_host "${1#*=}"; shift ;;
        *) break ;;
      esac
    done

    if [ "$grp" = releases ]; then
      if [ "${1:-}" = deploys ]; then shift; _scli_deploys "$@"; return; fi
      if [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ]; then "${run[@]}" release list "$@";
      else "${run[@]}" release "$@"; fi
      return
    fi

    case "$grp" in
      organizations) grp=org ;;
      projects)       grp=project ;;
      issues)         grp=issue ;;
      monitors)       grp=monitor ;;
      repos)          grp=repo ;;
      events)         grp=event ;;
    esac
    # Some groups default to `view`, so an empty group must explicitly list.
    if [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ]; then "${run[@]}" "$grp" list "$@";
    else "${run[@]}" "$grp" "$@"; fi
  }

  _scli_dispatch() {
    case "${1:-}" in
    # Moved commands
    login)                   shift; "${run[@]}" auth login "${login_args[@]}" "$@" ;;
    logout)                  shift; "${run[@]}" auth logout "$@" ;;
    send-envelope)           printf 'sentry-cli: use sentry event send <envelope-file> --raw and update v3 flags\n' >&2; return 64 ;;
    update)                  shift; "${run[@]}" cli upgrade "$@" ;;
    uninstall)               shift; "${run[@]}" cli uninstall "$@" ;;
    deploys)                 shift; _scli_deploys "$@" ;;
    upload-dif|upload-dsym)  shift; "${run[@]}" debug-files upload "$@" ;;
    upload-proguard)         shift; "${run[@]}" proguard upload "$@" ;;
    difutil)                 shift; "${run[@]}" debug-files "$@" ;;

    # Renamed groups accept v3 globals before the subcommand.
    releases|organizations|projects|issues|monitors|repos|events)
      _scli_group "$@" ;;

    # Everything else is unchanged
    *) "${run[@]}" "$@" ;;
  esac
  }

  # v3's `--allow-failure`/`SENTRY_ALLOW_FAILURE` made any command exit 0. v4
  # dropped it, so emulate here: swallow a non-zero status when it was set.
  if [ -n "$allow_failure" ]; then
    _scli_dispatch "$@" || { printf 'sentry-cli: command failed, but --allow-failure/SENTRY_ALLOW_FAILURE was set — exiting 0\n' >&2; return 0; }
  else
    _scli_dispatch "$@"
  fi
}
```

:::note
`env` runs the real `sentry` binary, bypassing the function (no infinite
recursion), and applies the translated `--auth-token`/`--url`/`--header` values
for that one call only. In `fish`, port the same preprocessing + `switch`/`case`
into a `function sentry-cli … end`.
:::

## Global flags and options

v3 accepted many of the same flags on (nearly) every command. v4 keeps a small
set as **global flags** and moves the rest to environment variables — so the
biggest migration gotcha is flags that silently no longer exist.

### Still global (work on every command)

| v3 flag | v4 |
|---------|----|
| `--org <slug>` | `--org` (accepted; also `SENTRY_ORG`) |
| `--project <slug>` | `--project` (accepted; also `SENTRY_PROJECT`, or `org/project` combo) |
| `--log-level <level>` | `--log-level` |
| — | `-v` / `--verbose` |
| — | `--json`, `--fields` (new — structured output) |

### Replaced by environment variables

| v3 flag | v4 replacement |
|---------|----------------|
| `--auth-token <tok>` | `SENTRY_AUTH_TOKEN` plus `SENTRY_FORCE_ENV_TOKEN=1` to override stored OAuth credentials (or `sentry auth login`) |
| `--url <url>` (self-hosted) | `SENTRY_URL` / `SENTRY_HOST`, or pass the URL as a command argument |
| `--header "K: V"` | `SENTRY_CUSTOM_HEADERS` |

The [compatibility shim](#drop-in-compatibility-shim) above translates
`--auth-token`, `--url`, and `--header` into these env vars automatically. For
`--auth-token`, it sets both `SENTRY_AUTH_TOKEN` and
`SENTRY_FORCE_ENV_TOKEN=1` so the explicit flag overrides stored OAuth
credentials as it did in v3.

### Dropped

- `--quiet` (and its `--silent` alias) has no direct replacement — pipe the
  output (non-TTY is plain) or use `--log-level error`.
- `--allow-failure` (and the `SENTRY_ALLOW_FAILURE` env var), which made any
  command exit `0` even on error, is **not implemented in v4** and will be
  rejected as an unknown flag. Handle failures in your own script (e.g.
  `sentry … || true`); the [shim](#drop-in-compatibility-shim) above emulates
  the old behavior when it sees the flag or env var.
- `SENTRY_API_KEY` (the v3 `apiKey` option) and `SENTRY_VCS_REMOTE` (the
  `vcsRemote` option) are no longer honored — use `SENTRY_AUTH_TOKEN` for auth.
- `SENTRY_CUSTOM_HEADERS` only applies to self-hosted Sentry; custom headers are
  ignored for `sentry.io`.

:::caution
Command-specific flags changed more than the global ones, and some v3 flags
don't exist in v4 yet. A few notable ones:

- `release set-commits` drops `--ignore-missing` and `--ignore-empty`.
- `release deploy` takes separate positional arguments for the release,
  environment, and optional name (`[<org>/]<version> <environment> [name]`),
  not `--env`/`--name`.
- `sourcemap upload`/`inject` drop several flags (see [Sourcemaps](#sourcemaps)).

Before relying on a flag, confirm it with `sentry <command> --help` — that's the
authoritative list for v4. If a flag you depend on is missing, please
[open an issue](https://github.com/getsentry/toolkit/issues).
:::

## Node.js wrapper (`SentryCli` class)

v3's `@sentry/cli` package exported a `SentryCli` class for programmatic use:

```js
// v3
const SentryCli = require("@sentry/cli");
const cli = new SentryCli(null, { authToken: process.env.SENTRY_AUTH_TOKEN });
await cli.releases.new("1.0.0");
await cli.releases.uploadSourceMaps("1.0.0", { include: ["./dist"] });
await cli.releases.setCommits("1.0.0", { auto: true });
await cli.releases.finalize("1.0.0");
```

v4 does **not** ship the `SentryCli` class. Instead, the `sentry` package is
itself usable as a library via `createSentrySDK()`, which exposes a typed method
for **every** command (full reference: [Library Usage](/library-usage/)):

```js
// v4
import createSentrySDK from "sentry";
const sdk = createSentrySDK({ token: process.env.SENTRY_AUTH_TOKEN });
await sdk.release.create({ orgVersion: "1.0.0" });
await sdk.sourcemap.upload({ directory: "./dist", release: "1.0.0" });
await sdk.release["set-commits"]({ orgVersion: "1.0.0", auto: true });
await sdk.release.finalize({ orgVersion: "1.0.0" });
```

:::note
The `sentry` npm package requires **Node.js 20+** (v3's `@sentry/cli` supported
older runtimes). On Node.js 22.15+ it uses the built-in `node:sqlite` module; on
Node.js 20–22.14 it transparently falls back to a bundled WASM SQLite driver, so
no native module or extra install step is needed. The standalone binary bundles
its own runtime and is unaffected by your installed Node.js version.

For best performance we strongly recommend the standalone binary or Node.js
22.15+ — the WASM fallback can't use SQLite WAL mode, making its local cache
slower and less concurrency-friendly.
:::

Mapping:

| v3 (`@sentry/cli`) | v4 (`sentry`) |
|--------------------|---------------|
| `new SentryCli(configFile, { authToken })` | `createSentrySDK({ token })` (`configFile` dropped) |
| `cli.releases.new(v)` | `sdk.release.create({ orgVersion: v })` |
| `cli.releases.finalize(v)` | `sdk.release.finalize({ orgVersion: v })` |
| `cli.releases.setCommits(v, o)` | `sdk.release["set-commits"]({ orgVersion: v, ...o })` |
| `cli.releases.uploadSourceMaps(v, { include })` | `sdk.sourcemap.upload({ directory, release: v })` |
| `cli.releases.newDeploy(v, { env, name, url })` | `sdk.release.deploy({ orgVersion: v, environment: env, name, url })` |
| `cli.releases.proposeVersion()` | `sdk.release["propose-version"]()` |
| `cli.execute(args)` | `sdk.run(...args)` |

Note the argument reshaping: the v3 `uploadSourceMaps` `include` array becomes
the `directory` argument of `sourcemap.upload`, and the release is optional
(sourcemap upload is keyed by debug ID, as it has been since v2).

### Codemod

To automate the mechanical parts of this migration, run the
[Codemod](https://codemod.com) from your project root (it rewrites the import,
constructor, and method chain, and inserts `// TODO(sentry-v4): …` comments where
option shapes changed and need a manual check).

For now, run it from the CLI repo's source — clone the repo, then point the
Codemod runner at the transform and your project directory:

```bash
git clone --depth 1 https://github.com/getsentry/cli /tmp/sentry-cli-src

# From your project root (-t . targets the current directory)
npx codemod@latest jssg run --language typescript \
  /tmp/sentry-cli-src/codemods/sentry-v3-to-v4/scripts/codemod.ts -t .
```

:::note
Once the codemod is published to the [Codemod registry](https://codemod.com), the
shorter form below will work — until then, use the run-from-source command above:

```bash
npx codemod@latest @sentry/cli-v3-to-v4
```
:::

It rewrites `.js`/`.ts` files in place. Review the diff afterward — argument
shapes differ (especially for `uploadSourceMaps` and `newDeploy`), so the codemod
flags those rather than guessing. See
[`codemods/sentry-v3-to-v4`](https://github.com/getsentry/cli/tree/main/codemods/sentry-v3-to-v4)
for the source and test fixtures.

## Output and scripting

v4 produces richer human output (Markdown, rendered on a TTY) but stays
**script-friendly**:

- **Piping / non-TTY** automatically emits plain text — no ANSI codes.
- **`--json`** on any command emits stable JSON for machines; combine with
  `--fields` to select columns.
- Color respects `NO_COLOR`, `FORCE_COLOR`, and `SENTRY_PLAIN_OUTPUT`.

```bash
# v3: parse text with grep/awk
sentry-cli releases list | awk '{print $1}'

# v4: query structured JSON
sentry release list --json | jq -r '.[].version'
```

If a script parsed the old plain-text tables, switch it to `--json` — it's far
more robust than screen-scraping.

## Authentication

v4 adds a browser-based **OAuth device flow** for interactive use, while still
honoring tokens for CI:

```bash
# Interactive (opens a browser, no token needed)
sentry auth login

# Check who you are / token validity
sentry auth status
sentry auth whoami        # or the top-level: sentry whoami

# CI / non-interactive — unchanged from v3
export SENTRY_AUTH_TOKEN=sntrys_…
sentry auth status
```

Stored OAuth credentials take precedence over `SENTRY_AUTH_TOKEN` by default.
Set `SENTRY_FORCE_ENV_TOKEN=1` when an environment token must override a stored
login. (v4 also accepts `SENTRY_TOKEN` as an alias for it.)

Note: there is **no `--auth-token` flag** in v4 — authentication comes from
`sentry auth login`, `SENTRY_AUTH_TOKEN`, or `.sentryclirc`. See
[Global flags](#global-flags-and-options) below.

## Exit codes

v3 mostly exited `1` on any error. v4 uses [semantic exit
codes](/exit-codes/) so scripts and CI can branch on the failure category
(`1x` auth, `2x` input/config, `3x` API/network, `4x` feature/billing, …).

If a script did `sentry-cli … || handle_error`, it still works — any non-zero
code triggers the fallback. Only update it if you were matching the **specific**
value `1`.

## Sourcemaps

The command maps `sourcemaps` → `sourcemap` (the plural is aliased, so existing
invocations keep working):

```bash
# v3
sentry-cli sourcemaps upload ./dist

# v4 (either form works)
sentry sourcemap upload ./dist
```

Two behavioral differences to be aware of:

- **Positional args:** v3 accepted multiple paths (`[PATHS]...`); v4 takes a
  single `<directory>` (both `upload` and `inject`). Run one invocation per
  directory.
- **Flags:** v4 `sourcemap upload` keeps `--release`, `--dist`, `--url-prefix`,
  `--ext`, `--ignore`, `--ignore-file`, `--strip-prefix`,
  `--strip-common-prefix`, `--no-rewrite`, `--allow-empty`. These v3 flags are
  **not present** in v4: `--url-suffix`, `--note`, `--validate`, `--decompress`,
  `--wait`, `--wait-for`, `--no-sourcemap-reference`, `--debug-id-reference`,
  `--bundle`, `--bundle-sourcemap`, `--strict`. `sourcemap inject` also drops
  `--release`. Run `sentry sourcemap upload --help` for the current set.
- **`--debug-id-reference` is now automatic:** in v3 that flag let `sourcemaps
  upload` take the debug ID from the linked sourcemap when it couldn't verify
  one in the bundle itself, for example in binary bundles.
  v4 does this by default. If a sourcemap already carries `debug_id`
  — from a bundler plugin configured with `sourcemaps.disable:
  'disable-upload'`, or copied across by a tool like React Native's
  `copy-debugid.js` — `inject` and `upload` adopt that ID rather than generating a
  new one.

See [`sourcemap`](/commands/sourcemap/) for details.

## Configuration

Configuration precedence is unchanged in spirit and fully backward compatible:

1. CLI flags
2. `SENTRY_ORG` / `SENTRY_PROJECT` env vars (`SENTRY_PROJECT` accepts
   `org/project`)
3. Stored defaults (`sentry auth login` / `sentry cli defaults`)
4. DSN auto-detection from your source and `.env` files
5. Directory-name inference

Your existing **`.sentryclirc`** and `SENTRY_*` environment variables are still
read. See [Configuration](/configuration/) for the full list.

## Getting help

- `sentry --help` — top-level command list
- `sentry <command> --help` — details and flags for any command
- [Command reference](/commands/) · [Exit codes](/exit-codes/) ·
  [Configuration](/configuration/)

If a command you relied on isn't covered here, please
[open an issue](https://github.com/getsentry/toolkit/issues) — we want the
migration to be painless.
