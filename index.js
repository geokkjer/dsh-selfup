/**
 * dsh-selfup — self-update and deployment tools for DeepSeek Harness.
 *
 * A bundle plugin (`dsh.bundle.patch` → `cordis.patch.yml`) that registers four
 * model-visible tools on the harness `tools` registry with zero runtime
 * dependencies: it talks to the repo through the `shell` service the harness
 * already mounts, so this package imports nothing at runtime.
 *
 *   dsh_update_status — read-only state of the checkout, launcher, and service
 *   dsh_update        — git fetch + fast-forward pull, pnpm install, pnpm run build
 *   dsh_install       — install `dsh` to ~/.local/bin (mode=local) or build an Arch
 *                       package (mode=arch) from the published npm tarball
 *   dsh_systemd       — manage the `dsh-web` systemd USER service for `dsh web`
 *
 * @module dsh-selfup
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-selfup'

/** Hard dependencies: the tool registry and the bash execution seam. */
export const inject = ['tools', 'shell']

/** The repo this plugin maintains; overridden by discovery at call time. */
const DEFAULT_REPO = process.env.DSH_SELFUP_REPO ?? '/home/geir/Projects/deepseek-harness'

/**
 * Resolve the session sandbox policy so writes outside the workspace (launcher,
 * systemd unit, Arch build dir) inherit the session's approved mode instead of
 * the executor's confining default.
 * @param ctx - the Cordis context.
 * @param exec - the tool execution context (may carry the calling agent).
 * @returns the resolved execution policy, or undefined when none is mounted.
 */
function resolvePolicy(ctx, exec) {
  const sp = ctx.get('sandboxPolicy')
  if (sp === undefined) return undefined
  return sp.resolve(exec && exec.agent ? { session: exec.agent.session } : {})
}

/** Canonical text renderer shared by every tool. */
function textRender(_args, value) {
  return [{ type: 'text', text: value.summary }]
}

/** A tool definition with the shared renderer; parameters/output are raw JSON Schema. */
function toolDefinition({ name, description, parameters, schema, execute }) {
  return {
    name,
    description,
    parameters,
    output: { schema, render: textRender },
    execute,
  }
}

/**
 * Apply the plugin: register the four tools. Each execute resolves the session
 * sandbox policy, discovers the repo root, and drives the `shell` service.
 * @param ctx - the Cordis context (provides `tools` and `shell` via inject).
 */
export function apply(ctx) {
  const shell = ctx.shell

  const runCmd = async (command, opts = {}) => {
    const spec = shell.resolve({
      command,
      workdir: opts.workdir,
      timeoutMs: opts.timeoutMs ?? 120000,
      stdoutMaxBytes: opts.maxBytes ?? 4000000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.policy ? { sandboxPolicy: opts.policy } : {}),
    })
    return shell.run(spec)
  }

  const startProc = (command, opts = {}) => {
    const spec = shell.resolve({
      command,
      workdir: opts.workdir,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.policy ? { sandboxPolicy: opts.policy } : {}),
    })
    return shell.start(spec)
  }

  const waitProc = async (proc) => {
    await proc.done
    const read = proc.readOutput()
    return {
      exitCode: proc.exitCode === null ? -1 : proc.exitCode,
      signal: proc.signal,
      delta: read.delta || '',
      lossy: read.lossy === true,
      spillPath: read.stdoutSpillPath || read.stderrSpillPath || '',
    }
  }

  const shortSummary = (r) => {
    const out = (r.stdout.text || '').trim()
    const err = (r.stderr.text || '').trim()
    const lines = [out, err ? `[stderr] ${err}` : ''].filter(Boolean)
    return lines.join('\n').slice(-4000)
  }

  const repoRoot = async (opts) => {
    const r = await runCmd('git rev-parse --show-toplevel', { timeoutMs: 15000, policy: opts && opts.policy })
    return r.exitCode === 0 ? r.stdout.text.trim() : DEFAULT_REPO
  }

  const homeDir = async (opts) => {
    const r = await runCmd('printf "%s" "$HOME"', { timeoutMs: 15000, policy: opts && opts.policy })
    return r.exitCode === 0 && r.stdout.text.trim().length > 0 ? r.stdout.text.trim() : '/home/geir'
  }

  const nodePath = async (opts) => {
    const r = await runCmd('command -v node', { timeoutMs: 15000, policy: opts && opts.policy })
    return r.exitCode === 0 && r.stdout.text.trim().length > 0 ? r.stdout.text.trim() : 'node'
  }

  const versionFromManifest = async (repo, opts) => {
    const r = await runCmd(`grep -m1 '"version"' ${repo}/apps/cli/package.json`, { timeoutMs: 15000, policy: opts && opts.policy })
    const m = r.exitCode === 0 ? r.stdout.text.match(/"version"\s*:\s*"([^"]+)"/) : null
    return m ? m[1] : ''
  }

  // ── dsh_update_status ────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_update_status',
    description: 'Read-only status of the DeepSeek Harness checkout and services: repo path, branch, HEAD, ahead/behind origin/master, dirty files, CLI version, built-bin presence, ~/.local/bin/dsh launcher, and the dsh-web systemd user service state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        head: { type: 'string' },
        behind: { type: 'integer' },
        ahead: { type: 'integer' },
        dirtyCount: { type: 'integer' },
        dirtyFiles: { type: 'array', items: { type: 'string' } },
        version: { type: 'string' },
        binBuilt: { type: 'boolean' },
        launcherInstalled: { type: 'boolean' },
        launcherPath: { type: 'string' },
        serviceActive: { type: 'string' },
        serviceEnabled: { type: 'string' },
        serviceUnitInstalled: { type: 'boolean' },
      },
      required: ['ok', 'summary'],
    },
    async execute(_args, exec) {
      const policy = resolvePolicy(ctx, exec)
      const repo = await repoRoot({ policy })
      const home = await homeDir({ policy })
      const branchR = await runCmd(`git -C ${repo} symbolic-ref --short HEAD`, { timeoutMs: 15000, policy })
      const branch = branchR.exitCode === 0 ? branchR.stdout.text.trim() : 'unknown'
      const headR = await runCmd(`git -C ${repo} log -1 --format='%h %s'`, { timeoutMs: 15000, policy })
      const head = headR.exitCode === 0 ? headR.stdout.text.trim() : ''
      const countR = await runCmd(`git -C ${repo} rev-list --left-right --count origin/master...HEAD`, { timeoutMs: 15000, policy })
      let behind = 0
      let ahead = 0
      if (countR.exitCode === 0) {
        const parts = countR.stdout.text.trim().split(/\s+/)
        behind = Number(parts[0] || 0)
        ahead = Number(parts[1] || 0)
      }
      const dirtyR = await runCmd(`git -C ${repo} status --porcelain`, { timeoutMs: 15000, policy })
      const dirty = dirtyR.exitCode === 0 ? dirtyR.stdout.text.split('\n').filter(Boolean) : []
      const version = await versionFromManifest(repo, { policy })
      const binR = await runCmd(`test -x ${repo}/apps/cli/lib/bin.js && echo yes || echo no`, { timeoutMs: 15000, policy })
      const launcherR = await runCmd(`test -x ${home}/.local/bin/dsh && echo yes || echo no`, { timeoutMs: 15000, policy })
      const activeR = await runCmd('systemctl --user is-active dsh-web 2>/dev/null || echo inactive', { timeoutMs: 15000, policy })
      const enabledR = await runCmd('systemctl --user is-enabled dsh-web 2>/dev/null || echo unknown', { timeoutMs: 15000, policy })
      const unitR = await runCmd(`test -f ${home}/.config/systemd/user/dsh-web.service && echo yes || echo no`, { timeoutMs: 15000, policy })
      const binBuilt = binR.stdout.text.trim() === 'yes'
      const launcherInstalled = launcherR.stdout.text.trim() === 'yes'
      const serviceUnitInstalled = unitR.stdout.text.trim() === 'yes'
      const summary = [
        `repo: ${repo}`,
        `branch: ${branch} @ ${head}`,
        `origin/master: ${behind} behind, ${ahead} ahead`,
        `dirty: ${dirty.length} file(s)`,
        `cli version: ${version || '?'}`,
        `built bin: ${binBuilt ? 'present' : 'missing (run dsh_update to build)'}`,
        `launcher: ${launcherInstalled ? `${home}/.local/bin/dsh` : 'not installed (dsh_install mode=local)'}`,
        `service dsh-web: active=${activeR.stdout.text.trim()}, enabled=${enabledR.stdout.text.trim()}, unit=${serviceUnitInstalled ? 'present' : 'absent (dsh_systemd action=install)'}`,
      ].join('\n')
      return {
        ok: true,
        summary,
        repo,
        branch,
        head,
        behind,
        ahead,
        dirtyCount: dirty.length,
        dirtyFiles: dirty.slice(0, 20),
        version,
        binBuilt,
        launcherInstalled,
        launcherPath: `${home}/.local/bin/dsh`,
        serviceActive: activeR.stdout.text.trim(),
        serviceEnabled: enabledR.stdout.text.trim(),
        serviceUnitInstalled,
      }
    },
  }))

  // ── dsh_update ──────────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_update',
    description: 'Update the DeepSeek Harness checkout: git fetch + fast-forward pull, pnpm install, and a full build (pnpm run build), each as its own step. Refuses a dirty working tree unless force=true (auto-stash before the pull, pop after). Returns per-step exit codes and output tails. The running web session keeps its loaded code until the dsh-web service is restarted (dsh_systemd action=restart).',
    parameters: {
      type: 'object',
      properties: {
        pull: { type: 'boolean', description: 'Run git fetch + fast-forward merge (default true).' },
        install: { type: 'boolean', description: 'Run pnpm install after the pull (default true).' },
        build: { type: 'boolean', description: 'Run pnpm run build after install (default true).' },
        test: { type: 'boolean', description: 'Also run pnpm run test after the build (default false; slow).' },
        force: { type: 'boolean', description: 'Proceed with a dirty working tree by auto-stashing before the pull and popping after (default false).' },
      },
      additionalProperties: false,
    },
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        repo: { type: 'string' },
        beforeHead: { type: 'string' },
        afterHead: { type: 'string' },
        commits: { type: 'array', items: { type: 'string' } },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string' },
              ok: { type: 'boolean' },
              exitCode: { type: 'integer' },
              detail: { type: 'string' },
              spillPath: { type: 'string' },
            },
          },
        },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      const policy = resolvePolicy(ctx, exec)
      const repo = await repoRoot({ policy })
      const signal = exec && exec.signal
      const steps = []
      const beforeR = await runCmd(`git -C ${repo} rev-parse --short HEAD`, { timeoutMs: 15000, policy })
      const beforeHead = beforeR.exitCode === 0 ? beforeR.stdout.text.trim() : 'unknown'
      const needPull = args.pull !== false
      const needInstall = args.install !== false
      const needBuild = args.build !== false
      const needTest = args.test === true
      const force = args.force === true
      let stashed = false

      if (needPull) {
        const fetch = await runCmd(`git -C ${repo} fetch origin`, { timeoutMs: 300000, signal, policy })
        steps.push({
          name: 'git fetch',
          ok: fetch.exitCode === 0,
          exitCode: fetch.exitCode === null ? -1 : fetch.exitCode,
          detail: shortSummary(fetch),
        })
        if (fetch.exitCode !== 0) {
          return { ok: false, summary: `git fetch failed: ${shortSummary(fetch)}`, repo, beforeHead, steps }
        }
        const behindR = await runCmd(`git -C ${repo} rev-list --count HEAD..origin/master`, { timeoutMs: 15000, policy })
        const behindCount = behindR.exitCode === 0 ? Number(behindR.stdout.text.trim() || '0') : 0
        if (behindCount === 0 && !needInstall && !needBuild && !needTest) {
          return { ok: true, summary: `already up to date (${beforeHead}); nothing else requested.`, repo, beforeHead, afterHead: beforeHead, commits: [], steps }
        }
        if (behindCount === 0) {
          steps.push({ name: 'git pull (ff-only)', ok: true, exitCode: 0, detail: 'already up to date' })
        } else {
          const dirtyR = await runCmd(`git -C ${repo} status --porcelain`, { timeoutMs: 15000, policy })
          const dirtyList = dirtyR.exitCode === 0 ? dirtyR.stdout.text.split('\n').filter(Boolean) : []
          if (dirtyList.length > 0 && !force) {
            return {
              ok: false,
              summary: `working tree dirty (${dirtyList.length} file(s)); commit, clean, or run with force=true to auto-stash. First: ${dirtyList.slice(0, 5).join('; ')}`,
              repo,
              beforeHead,
              steps,
            }
          }
          if (dirtyList.length > 0) {
            const stash = await runCmd(`git -C ${repo} stash push -u -m dsh-selfup`, { timeoutMs: 60000, policy })
            stashed = stash.exitCode === 0
            steps.push({ name: 'git stash', ok: stashed, exitCode: stash.exitCode === null ? -1 : stash.exitCode, detail: shortSummary(stash) })
          }
          const merge = await runCmd(`git -C ${repo} merge --ff-only origin/master`, { timeoutMs: 300000, signal, policy })
          steps.push({ name: 'git pull (ff-only)', ok: merge.exitCode === 0, exitCode: merge.exitCode === null ? -1 : merge.exitCode, detail: shortSummary(merge) })
          if (merge.exitCode !== 0) {
            if (stashed) await runCmd(`git -C ${repo} stash pop`, { timeoutMs: 60000, policy })
            return { ok: false, summary: `git merge --ff-only failed: ${shortSummary(merge)}`, repo, beforeHead, steps }
          }
        }
      }

      const afterR = await runCmd(`git -C ${repo} rev-parse --short HEAD`, { timeoutMs: 15000, policy })
      const afterHead = afterR.exitCode === 0 ? afterR.stdout.text.trim() : 'unknown'

      if (needInstall) {
        const proc = startProc('pnpm install', { workdir: repo, signal, policy })
        const rep = await waitProc(proc)
        steps.push({ name: 'pnpm install', ok: rep.exitCode === 0, exitCode: rep.exitCode, detail: rep.delta.slice(-3000), spillPath: rep.spillPath })
        if (rep.exitCode !== 0) {
          return { ok: false, summary: `pnpm install failed: ${rep.delta.slice(-1000)}`, repo, beforeHead, afterHead, steps }
        }
      }
      if (needBuild) {
        const proc = startProc('pnpm run build', { workdir: repo, signal, policy })
        const rep = await waitProc(proc)
        steps.push({ name: 'pnpm run build', ok: rep.exitCode === 0, exitCode: rep.exitCode, detail: rep.delta.slice(-3000), spillPath: rep.spillPath })
        if (rep.exitCode !== 0) {
          return { ok: false, summary: `pnpm run build failed: ${rep.delta.slice(-1000)}`, repo, beforeHead, afterHead, steps }
        }
      }
      if (needTest) {
        const proc = startProc('pnpm run test', { workdir: repo, signal, policy })
        const rep = await waitProc(proc)
        steps.push({ name: 'pnpm run test', ok: rep.exitCode === 0, exitCode: rep.exitCode, detail: rep.delta.slice(-3000), spillPath: rep.spillPath })
      }
      if (stashed) {
        const pop = await runCmd(`git -C ${repo} stash pop`, { timeoutMs: 60000, policy })
        steps.push({ name: 'git stash pop', ok: pop.exitCode === 0, exitCode: pop.exitCode === null ? -1 : pop.exitCode, detail: shortSummary(pop) })
      }
      const logR = await runCmd(`git -C ${repo} log --oneline ${beforeHead}..${afterHead}`, { timeoutMs: 15000, policy })
      const commits = logR.exitCode === 0 ? logR.stdout.text.split('\n').filter(Boolean) : []
      const ok = steps.length > 0 && steps.every((s) => s.ok)
      return {
        ok,
        summary: `update ${ok ? 'succeeded' : 'finished with failures'}: ${beforeHead} -> ${afterHead} (${commits.length} new commit(s)). Restart the web service to apply the new code: dsh_systemd action=restart.`,
        repo,
        beforeHead,
        afterHead,
        commits,
        steps,
      }
    },
  }))

  // ── dsh_install ─────────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_install',
    description: 'Install the dsh CLI. mode=local (default): write a launcher to ~/.local/bin/dsh that execs the repo\'s built CLI (falling back to the source launcher) so `dsh` works from anywhere. mode=arch: generate a PKGBUILD for the published npm package and build it with makepkg, returning the package path to install with pacman.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['local', 'arch'], description: 'local (default) writes ~/.local/bin/dsh; arch builds an Arch package.' },
      },
      additionalProperties: false,
    },
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        mode: { type: 'string' },
        path: { type: 'string' },
        version: { type: 'string' },
        dir: { type: 'string' },
        pkgPath: { type: 'string' },
        pkgver: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      const policy = resolvePolicy(ctx, exec)
      const mode = args.mode === 'arch' ? 'arch' : 'local'
      const repo = await repoRoot({ policy })
      const home = await homeDir({ policy })
      const node = await nodePath({ policy })
      if (mode === 'local') {
        const wrapper = [
          '#!/usr/bin/env bash',
          '# dsh launcher - DeepSeek Harness (installed by dsh-selfup)',
          'export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"',
          `REPO=${repo}`,
          `NODE=${node}`,
          'if [[ -x "$REPO/apps/cli/lib/bin.js" ]]; then',
          '  exec "$NODE" "$REPO/apps/cli/lib/bin.js" "$@"',
          'fi',
          'cd "$REPO" || exit 1',
          'exec "$NODE" --import tsx/esm apps/cli/src/bin.ts "$@"',
          '',
        ].join('\n')
        const write = await runCmd(`mkdir -p ${home}/.local/bin && cat > ${home}/.local/bin/dsh <<'DSH_SELFUP_EOF'\n${wrapper}DSH_SELFUP_EOF\nchmod +x ${home}/.local/bin/dsh`, { timeoutMs: 15000, policy })
        const probe = await runCmd(`${home}/.local/bin/dsh --version`, { timeoutMs: 60000, policy })
        const version = probe.exitCode === 0 ? probe.stdout.text.trim() : shortSummary(probe)
        return {
          ok: write.exitCode === 0,
          summary: write.exitCode === 0 ? `installed ${home}/.local/bin/dsh; version: ${version}` : `write failed: ${shortSummary(write)}`,
          mode,
          path: `${home}/.local/bin/dsh`,
          version,
          detail: shortSummary(write),
        }
      }
      const npmVer = await versionFromManifest(repo, { policy })
      const pkgver = (npmVer || '0.1.0-rc.5').replace(/-/g, '.').replace(/^v/, '')
      const dir = `${home}/.cache/dsh-arch`
      const pkgbuild = [
        '# Maintainer: dsh-selfup plugin',
        'pkgname=dsh',
        `pkgver=${pkgver}`,
        'pkgrel=1',
        'pkgdesc="DeepSeek Harness CLI"',
        "arch=('any')",
        'url="https://github.com/deepseek-ai/deepseek-harness"',
        "license=('MIT')",
        "depends=('nodejs')",
        `source=("https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${npmVer || '0.1.0-rc.5'}.tgz")`,
        "sha256sums=('SKIP')",
        '',
        'package() {',
        '  cd "$srcdir"',
        '  npm install --prefix "$pkgdir/usr/lib/dsh" ./package',
        '  install -d "$pkgdir/usr/bin"',
        '  ln -s /usr/lib/dsh/node_modules/.bin/dsh "$pkgdir/usr/bin/dsh"',
        '}',
        '',
      ].join('\n')
      const hasMakepkg = await runCmd('command -v makepkg', { timeoutMs: 15000, policy })
      if (hasMakepkg.exitCode !== 0) {
        return { ok: false, summary: 'makepkg not found; install base-devel. PKGBUILD written for manual use.', mode, dir, pkgver, detail: pkgbuild }
      }
      const write = await runCmd(`mkdir -p ${dir} && cat > ${dir}/PKGBUILD <<'DSH_SELFUP_EOF'\n${pkgbuild}DSH_SELFUP_EOF`, { timeoutMs: 15000, policy })
      if (write.exitCode !== 0) {
        return { ok: false, summary: `PKGBUILD write failed: ${shortSummary(write)}`, mode, dir, pkgver, detail: pkgbuild }
      }
      const proc = startProc('makepkg -f', { workdir: dir, policy })
      const rep = await waitProc(proc)
      const pkgR = await runCmd(`ls ${dir}/*.pkg.tar.* 2>/dev/null | head -1`, { timeoutMs: 15000, policy })
      const pkgPath = pkgR.exitCode === 0 ? pkgR.stdout.text.trim() : ''
      return {
        ok: rep.exitCode === 0,
        summary: rep.exitCode === 0
          ? `built ${pkgPath}; install with: sudo pacman -U ${pkgPath}`
          : `makepkg failed: ${rep.delta.slice(-1200)}`,
        mode,
        dir,
        pkgPath,
        pkgver,
        detail: rep.delta.slice(-3000),
      }
    },
  }))

  // ── dsh_systemd ─────────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_systemd',
    description: 'Manage a systemd USER service running the web UI (dsh-web). install writes ~/.config/systemd/user/dsh-web.service (ExecStart: ~/.local/bin/dsh web --host 127.0.0.1 --port 3080), daemon-reloads and enables it (does not start). start/restart/stop/disable/status act on the unit. NOTE: start/restart terminate the currently running dsh web instance - including the session this tool runs in - so the new code only takes effect then; the port must be free.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'enable', 'disable', 'start', 'restart', 'stop'], description: 'What to do with the dsh-web user service.' },
        port: { type: 'integer', description: 'Listen port for the unit (default 3080).' },
        host: { type: 'string', description: 'Bind host for the unit (default 127.0.0.1).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        action: { type: 'string' },
        active: { type: 'string' },
        enabled: { type: 'string' },
        unitPath: { type: 'string' },
        unit: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      const policy = resolvePolicy(ctx, exec)
      const action = args.action
      const port = args.port ?? 3080
      const host = args.host ?? '127.0.0.1'
      const repo = await repoRoot({ policy })
      const home = await homeDir({ policy })
      const node = await nodePath({ policy })
      const unitPath = `${home}/.config/systemd/user/dsh-web.service`
      const launcher = `${home}/.local/bin/dsh`

      if (action === 'install') {
        const check = await runCmd(`test -x ${launcher} && echo yes || echo no`, { timeoutMs: 15000, policy })
        if (check.stdout.text.trim() !== 'yes') {
          return { ok: false, summary: `${launcher} missing - run dsh_install mode=local first.`, action, unitPath }
        }
        const nodeDir = node.includes('/') ? node.slice(0, node.lastIndexOf('/')) : ''
        const unit = [
          '[Unit]',
          'Description=DeepSeek Harness web UI',
          'After=network.target',
          '',
          '[Service]',
          'Type=simple',
          `WorkingDirectory=${repo}`,
          `Environment=DSH_HOME=${home}/.dsh`,
          `Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin`,
          `ExecStart=${launcher} web --host ${host} --port ${port}`,
          'Restart=on-failure',
          'RestartSec=3',
          '',
          '[Install]',
          'WantedBy=default.target',
          '',
        ].join('\n')
        const write = await runCmd(`mkdir -p ${home}/.config/systemd/user && cat > ${unitPath} <<'DSH_SELFUP_EOF'\n${unit}DSH_SELFUP_EOF\nsystemctl --user daemon-reload\nsystemctl --user enable dsh-web`, { timeoutMs: 60000, policy })
        const enabledR = await runCmd('systemctl --user is-enabled dsh-web 2>/dev/null || echo unknown', { timeoutMs: 15000, policy })
        return {
          ok: write.exitCode === 0,
          summary: write.exitCode === 0
            ? `installed and enabled ${unitPath} (enabled: ${enabledR.stdout.text.trim()}); start it with dsh_systemd action=start (frees port ${port} first).`
            : `install failed: ${shortSummary(write)}`,
          action,
          unitPath,
          enabled: enabledR.stdout.text.trim(),
          detail: shortSummary(write),
        }
      }

      const r = await runCmd(`systemctl --user ${action} dsh-web`, { timeoutMs: 60000, policy })
      const activeR = await runCmd('systemctl --user is-active dsh-web 2>/dev/null || echo inactive', { timeoutMs: 15000, policy })
      const enabledR = await runCmd('systemctl --user is-enabled dsh-web 2>/dev/null || echo unknown', { timeoutMs: 15000, policy })
      let unit = ''
      if (action === 'status') {
        const cat = await runCmd(`cat ${unitPath} 2>/dev/null || echo 'no unit file'`, { timeoutMs: 15000, policy })
        unit = cat.stdout.text
      }
      return {
        ok: r.exitCode === 0,
        summary: `${action} -> active: ${activeR.stdout.text.trim()}, enabled: ${enabledR.stdout.text.trim()}${r.exitCode === 0 ? '' : ` - ${shortSummary(r)}`}`,
        action,
        active: activeR.stdout.text.trim(),
        enabled: enabledR.stdout.text.trim(),
        unitPath,
        unit,
        detail: shortSummary(r),
      }
    },
  }))
}
