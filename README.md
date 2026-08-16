# dsh-selfup

Self-update and deployment tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), shipped as an installable profile bundle.

`dsh-selfup` gives the agent (and you) four maintenance tools over the harness checkout:

| Tool | What it does |
|---|---|
| [`dsh_update_status`](#dsh_update_status) | Read-only: repo, branch, HEAD, ahead/behind, dirty files, CLI version, built-bin freshness, launcher and systemd-unit state |
| [`dsh_update`](#dsh_update) | `git fetch` → fast-forward pull → `pnpm install` → `pnpm run build` (optional `pnpm run test`), each as its own reported step |
| [`dsh_install`](#dsh_install) | Install `dsh` to `~/.local/bin` (`mode=local`, from the repo) or build an Arch package from the published npm tarball (`mode=arch`) |
| [`dsh_systemd`](#dsh_systemd) | Manage a systemd **user** service running `dsh web` (`~/.config/systemd/user/dsh-web.service`) |

Zero runtime dependencies: the plugin talks to the checkout through the harness's own `shell` service, and `ctx.tools.register()` accepts the raw definitions directly.

## Requirements

- A DeepSeek Harness **repo checkout** (the tools operate on `git rev-parse --show-toplevel` from the working directory, falling back to `$DSH_SELFUP_REPO`)
- `git`, `node`, `pnpm` on `PATH`
- `mode=arch` additionally needs `makepkg` (Arch `base-devel`); the systemd actions need a running user systemd instance

## Install

Install the bundle into a profile and restart the web server:

```sh
dsh plugin --profile web add dsh-selfup          # once published to npm
dsh plugin --profile web add github:geokkjer/dsh-selfup   # or straight from this repo
```

Or, for a local checkout of this plugin:

```sh
cd /path/to/dsh-selfup
dsh plugin --profile web add .
```

`dsh plugin` runs `pnpm add` in the profile directory and registers the package as a bundle layer (`dsh.bundle.patch` → `cordis.patch.yml`). After the next `dsh web` start, the four tools appear in every session.

To develop against this repo without a build step, the package entry is plain ESM (`index.js`) with a hand-written `index.d.ts`; there is nothing to compile.

## Tools

### `dsh_update_status`

Read-only snapshot of the checkout and its deployment:

- repo path, branch, HEAD
- commits behind / ahead of `origin/master`
- dirty working-tree file count (first 20 names)
- CLI version from `apps/cli/package.json`
- built-bin presence (`apps/cli/lib/bin.js`)
- `~/.local/bin/dsh` launcher presence
- `dsh-web` systemd unit: active, enabled, file present

### `dsh_update`

Update the checkout in four independently skippable steps:

1. `git fetch origin`
2. `git merge --ff-only origin/master` (never rebases or creates merge commits)
3. `pnpm install`
4. `pnpm run build` (and optionally `pnpm run test`)

Parameters (all optional booleans, default `true`): `pull`, `install`, `build`, `test`, `force`.

- A dirty working tree refuses the pull **unless** `force=true`, which auto-stashes before the pull and pops after (a pop conflict is reported, not hidden).
- When the tree is already at `origin/master` and nothing else is requested, the tool says so and stops.
- Each step returns its exit code and an output tail; long `pnpm` steps run as background processes with the call's abort signal forwarded, so a cancelled call kills the step.
- The running web session keeps its loaded code — restart the service to apply: `dsh_systemd action=restart`.

### `dsh_install`

- `mode=local` (default): writes a launcher to `~/.local/bin/dsh` that execs the repo's built CLI (`apps/cli/lib/bin.js`) and falls back to the tsx source launcher when the build is absent. `dsh --version` then works from anywhere and stays in sync with the repo.
- `mode=arch`: writes a `PKGBUILD` to `~/.cache/dsh-arch` sourcing the published npm tarball at the checkout's version, builds it with `makepkg -f`, and returns the package path for `sudo pacman -U`.

### `dsh_systemd`

Manage the `dsh-web` user service that runs `dsh web --host <host> --port <port>` (defaults `127.0.0.1:3080`):

- `action=install` writes the unit file, `daemon-reload`s and `enable`s it — it does **not** start it.
- `status` / `start` / `restart` / `stop` / `disable` act on the unit directly.

> ⚠️ `start` / `restart` terminate the currently running `dsh web` instance — including the session calling the tool — so the new code only takes effect then. The port must be free (stop any terminal `pnpm run dsh web` first).

The unit sets `WorkingDirectory` to the repo, `DSH_HOME` to `$HOME/.dsh`, and `PATH` to include the node bin directory, so it behaves like a hand-started `dsh web`.

## Sandbox policy

The plugin resolves the session's sandbox policy (`sandboxPolicy.resolve({ session })`) and passes it to every shell call, so writes outside the workspace — the launcher, the unit file, the Arch build dir — inherit the session's approved mode instead of the executor's confining default.

## Tests

```sh
npm test
```

Applies the plugin against a stub context and asserts the four tools register with the expected names and well-formed JSON schemas (no harness needed).

## License

[MIT](LICENSE)
