# dsh-selfup

Self-update and deployment tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), shipped as an installable profile bundle.

`dsh-selfup` gives the agent (and you) four maintenance tools over the harness checkout:

| Tool | What it does |
|---|---|
| [`dsh_update_status`](#dsh_update_status) | Repo, branch, HEAD, ahead/behind (fetches first), tracked and untracked files, CLI version, built-bin freshness, launcher and systemd-unit state |
| [`dsh_update`](#dsh_update) | `git fetch` → fast-forward pull → `pnpm install` → `pnpm run build` (optional `pnpm run test`), each as its own reported step |
| [`dsh_install`](#dsh_install) | Install `dsh` to `~/.local/bin` (`mode=local`, from the repo) or build an Arch package from the published npm tarball (`mode=arch`) |
| [`dsh_systemd`](#dsh_systemd) | Manage a systemd **user** service running `dsh web` (`~/.config/systemd/user/dsh-web.service`) |

Zero runtime dependencies: the plugin talks to the checkout through the harness's own `shell` service, and `ctx.tools.register()` accepts the raw definitions directly. (Node builtins only — `node:fs`, `node:os` — for the writable-root check.)

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

Snapshot of the checkout and its deployment:

- repo path, branch, HEAD
- commits behind / ahead of `origin/master`
- tracked changes and untracked paths, counted and listed separately (first 20 of each)
- CLI version from `apps/cli/package.json`
- built-bin presence (`apps/cli/lib/bin.js`)
- `~/.local/bin/dsh` launcher presence
- `dsh-web` systemd unit: active, enabled, file present

The ahead/behind count compares against `origin/master`, which only moves on a fetch, so the tool runs `git fetch origin` first — otherwise a checkout hundreds of commits behind still reports `0 behind`. Pass `fetch=false` to stay offline; the summary then discloses `fetch=false`, and a failed fetch is reported rather than presented as up-to-date. When the session file policy cannot write the checkout, the fetch is **skipped and disclosed** rather than reported as a failure (see [Sandbox policy](#sandbox-policy)).

### `dsh_update`

Update the checkout in four independently skippable steps:

1. `git fetch origin`
2. `git merge --ff-only origin/master` (never rebases or creates merge commits)
3. `pnpm install`
4. `pnpm run build` (and optionally `pnpm run test`)

Parameters (all optional booleans): `pull`, `install`, `build`, `restart` default to `true`; `test`, `force`, `full_access` default to `false`.

- Uncommitted **tracked** changes refuse the pull **unless** `force=true`, which auto-stashes them before the pull and pops after (a pop conflict is reported, not hidden). The stash never includes untracked files.
- **Untracked** files never block the pull, so unrelated work in the checkout — a scratch directory, research notes — stays where it is instead of being swept into a stash. If the fast-forward genuinely collides with an untracked path, `git merge --ff-only` fails and the tool reports it.
- When the tree is already at `origin/master` and nothing else is requested, the tool says so and stops.
- Each step returns its exit code and an output tail; long `pnpm` steps run as background processes with the call's abort signal forwarded, so a cancelled call kills the step.
- If `pnpm run build` fails (commonly a stale-`lib/` `MISSING_EXPORT` after a pull renames or removes a package), the tool runs `pnpm run clean` and retries the build once; a genuinely broken build is still reported as a failure.
- After a successful build of new commits the tool restarts the `dsh-web` service a few seconds later (via a transient `systemd-run` timer) so the new code loads and the stale-web-view plugin error clears; pass `restart=false` to defer. The restart terminates the calling session.

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

The plugin resolves the session's sandbox policy (`sandboxPolicy.resolve({ session })`) and passes it to every shell call, so writes outside the workspace — the launcher, the unit file, the Arch build dir, the checkout itself — inherit the session's approved mode instead of the executor's confining default.

Because those paths usually lie **outside** the session workspace, each writing tool checks the resolved policy before it touches anything:

- **Contained** (`danger-full-access`, or a `workspace-write` root that covers the target) — the tool runs under the session policy, unchanged.
- **Confined** — the tool refuses up front and reports what was blocked, under which policy, and the levers that resolve it. A confined checkout therefore produces a clear refusal, not an opaque `Read-only file system` from the middle of a pull.
- **`full_access: true`** — the explicit lever: that one call runs with `danger-full-access`, bypassing the session file policy. **Only pass it with the user's explicit consent**, and the result reports `sandbox.escalated: true`, so the bypass is visible in the transcript. This is the lever that works where approval prompts are disabled.
- **Approval route** — without `full_access`, the tool asks the harness approval channel exactly as `tool-bash`/`tool-fs` do (`ctx.approval.request`, same reason shape) and widens only on `allowed-once`. No channel, no agent, a rejection, or a cancellation all mean *refused*, reported with the outcome — never a silent bypass.

Which paths each tool gates, and when:

| Tool | Gated path | Notes |
|---|---|---|
| `dsh_update` | the checkout (`git rev-parse --show-toplevel`) | the whole call is gated before the first step |
| `dsh_update_status` | the checkout | only the fetch writes, so a confined policy skips and discloses it instead of failing the status read |
| `dsh_install` | `~/.local/bin/dsh` (local) or `~/.cache/dsh-arch` (arch) | |
| `dsh_systemd` | `~/.config/systemd/user/dsh-web.service` | only `action=install` writes a file; `status`/`start`/`stop`/… talk to the user manager and stay available under a read-only policy |

## Tests

```sh
npm test
```

Applies the plugin against a stub context and asserts the four tools register with the expected names and well-formed JSON schemas, then drives the scripted `shell` seam to exercise `dsh_update`'s clean-and-retry fallback, its restart scheduling, the tracked/untracked stash rules, and the sandbox-policy gate (refusal, `full_access`, and the approval route). No harness is required.

## License

[MIT](LICENSE)
