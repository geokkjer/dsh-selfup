/**
 * dsh-selfup — self-update and deployment tools for DeepSeek Harness.
 *
 * A bundle plugin (`dsh.bundle.patch` → `cordis.patch.yml`) that registers four
 * model-visible tools on the harness `tools` registry with zero runtime
 * dependencies: it talks to the repo through the `shell` service the harness
 * already mounts, so this package imports nothing at runtime.
 *
 *   dsh_update_status — checkout, launcher, and service state (fetches origin first)
 *   dsh_update        — git fetch + fast-forward pull, pnpm install, pnpm run build
 *   dsh_install       — install `dsh` to ~/.local/bin (mode=local) or build an Arch
 *                       package (mode=arch) from the published npm tarball
 *   dsh_systemd       — manage the `dsh-web` systemd USER service for `dsh web`
 *
 * @module dsh-selfup
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'

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

/** The one mode strictly wider than `workspace-write` in the harness's ladder. */
const FULL_ACCESS = 'danger-full-access'

/** Canonicalize for containment checks; an unresolvable path keeps its spelling. */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Whether `path` is `root` or sits under it, by spelling and by canonical identity. */
function isUnder(path, root) {
  if (typeof path !== 'string' || typeof root !== 'string' || root === '') return false
  const prefixed = root.endsWith(sep) ? root : root + sep
  if (path === root || path.startsWith(prefixed)) return true
  const cPath = canonical(path)
  const cRoot = canonical(root)
  return cPath === cRoot || cPath.startsWith(cRoot.endsWith(sep) ? cRoot : cRoot + sep)
}

/**
 * The roots a policy lets a confined execution WRITE under, mirroring the
 * harness's shared derivation (`@deepseek-ai/dsh-sandbox` `roots.ts`):
 * `workspace-write` grants the workspace root plus the platform temp areas,
 * `read-only` grants nothing, and `danger-full-access` is unrestricted.
 * @param policy - the resolved execution policy.
 * @returns `null` when unrestricted, otherwise the writable roots.
 */
function writableRoots(policy) {
  if (policy.mode === FULL_ACCESS) return null
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].filter((root) => typeof root === 'string' && root !== ''))]
}

/**
 * Whether `path` may be written under `policy`.
 * @param policy - the resolved execution policy.
 * @param path - the absolute path a tool needs to write.
 * @returns true when the policy grants it.
 */
function canWrite(policy, path) {
  const roots = writableRoots(policy)
  return roots === null || roots.some((root) => isUnder(path, root))
}

/**
 * Ask the harness approval channel for the one strictly-wider mode, mirroring
 * the reference escalation in `@deepseek-ai/dsh-sandbox` (`approveEscalation`):
 * same reason shape, same fail-closed ladder, never a quiet bypass.
 * @param ctx - the Cordis context.
 * @param exec - the tool execution context (agent, callId, signal).
 * @param toolName - the tool name recorded on the approval request.
 * @param blocked - the paths the session policy does not grant.
 * @param base - the session policy being escalated.
 * @returns the closed outcome (`allowed-once`, `rejected`, `cancelled`, `unavailable`).
 */
async function requestEscalation(ctx, exec, toolName, blocked, base) {
  const approval = ctx.get('approval')
  const agent = exec && exec.agent
  // Fail closed: without both a channel and an agent to route it through, there
  // is nothing to ask, so the tool refuses instead of proceeding unconfined.
  if (approval === undefined || agent === undefined) return 'unavailable'
  const detail = `${toolName} must write ${blocked.join(', ')}, outside this session's ${base.mode} root ${JSON.stringify(base.workspaceRoot)}`
  try {
    return await approval.request({
      agent,
      toolName,
      callId: exec.callId,
      reason: `escalate sandbox to ${FULL_ACCESS}: ${detail}`,
      displayReason: {
        en: `Allow ${toolName} to write outside the session workspace: ${blocked.join(', ')}`,
        zh: `允许 ${toolName} 写入会话工作区之外：${blocked.join(', ')}`,
      },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch {
    // A seam that throws (closed channel, no open turn) is an unavailable
    // channel, not a grant — the same reading `approveEscalation` gives it.
    return 'unavailable'
  }
}

/**
 * The policy a writing tool must run under, plus how it was obtained.
 *
 * The session policy governs by default. When it confines a path the tool must
 * write, this does NOT quietly widen: it either honors the explicit
 * `full_access` the caller passed — the user's consent, and the lever that
 * still works where approval prompts are disabled — or asks the approval
 * channel exactly as the harness's own bash and filesystem tools do. Anything
 * else returns a `refusal` for the tool to report before it touches anything.
 * @param ctx - the Cordis context.
 * @param exec - the tool execution context.
 * @param args - the tool arguments; `full_access: true` opts into the override.
 * @param paths - the absolute paths this call must be able to write.
 * @param toolName - the tool name recorded on an approval request.
 * @returns `{ policy, mode, escalated, via }`, or `{ refusal }`.
 */
async function policyForWrites(ctx, exec, args, paths, toolName) {
  const base = resolvePolicy(ctx, exec)
  if (base === undefined) return { policy: undefined, mode: 'executor-default', escalated: false }
  if (base.mode === FULL_ACCESS) return { policy: base, mode: base.mode, escalated: false }

  const blocked = paths.filter((path) => !canWrite(base, path))
  if (blocked.length === 0) return { policy: base, mode: base.mode, escalated: false }

  if (args && args.full_access === true) {
    return { policy: { ...base, mode: FULL_ACCESS }, mode: FULL_ACCESS, escalated: true, via: 'full_access=true' }
  }

  const outcome = await requestEscalation(ctx, exec, toolName, blocked, base)
  if (outcome === 'allowed-once') {
    return { policy: { ...base, mode: FULL_ACCESS }, mode: FULL_ACCESS, escalated: true, via: 'approval' }
  }
  return { refusal: { blocked, base, outcome } }
}

/**
 * The structured refusal a confined tool returns instead of failing mid-write
 * with an opaque read-only error: what was blocked, under which policy, why the
 * escalation did not happen, and the levers that make it work.
 * @param toolName - the refusing tool.
 * @param refusal - the `refusal` returned by {@link policyForWrites}.
 * @param extra - result fields to carry onto the refusal (repo, mode, …).
 * @returns the tool result.
 */
function refusalResult(toolName, refusal, extra = {}) {
  const { blocked, base, outcome } = refusal
  const why = outcome === 'unavailable'
    ? 'no approval channel is available for this call (approval prompts are disabled for this session)'
    : `the approval request was ${outcome}`
  return {
    ok: false,
    ...extra,
    summary: [
      `${toolName} did not run: it must write outside this session's file policy and the escalation was not granted.`,
      `- policy: ${base.mode} (writable root: ${base.workspaceRoot})`,
      `- blocked path(s): ${blocked.join(', ')}`,
      `- escalation: ${why}`,
      "Levers: (1) re-call with full_access=true, which bypasses the session file policy - only with the user's explicit consent; (2) enable approval prompts and retry so the escalation can be approved; (3) run the session with a wider sandbox mode.",
    ].join('\n'),
    sandbox: { mode: base.mode, workspaceRoot: base.workspaceRoot, blocked, escalation: outcome },
  }
}

/** The `sandbox` result field describing an escalated or inherited run. */
function sandboxField(gate) {
  return gate.escalated
    ? { mode: gate.mode, escalated: true, via: gate.via }
    : { mode: gate.mode, escalated: false }
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

  /**
   * Split `git status --porcelain` output into tracked changes and untracked
   * paths. Untracked files do not block a fast-forward, so only the tracked
   * set justifies refusing an update or moving work into a stash.
   * @param lines - non-empty porcelain status lines.
   * @returns `tracked` change lines and `untracked` (`??`) path lines.
   */
  const partitionStatus = (lines) => {
    const tracked = []
    const untracked = []
    for (const line of lines) {
      if (line.startsWith('??')) untracked.push(line)
      else tracked.push(line)
    }
    return { tracked, untracked }
  }

  // ── dsh_update_status ────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_update_status',
    description: 'Status of the DeepSeek Harness checkout and services: repo path, branch, HEAD, ahead/behind origin/master, tracked and untracked files, CLI version, built-bin presence, ~/.local/bin/dsh launcher, and the dsh-web systemd user service state. Fetches origin first so the ahead/behind count reflects the real remote rather than the last fetch (pass fetch=false to stay offline and read local refs). When the session file policy cannot write the checkout, the fetch is skipped and disclosed rather than reported as a failure (pass full_access=true with the user\'s consent to fetch anyway).',
    parameters: {
      type: 'object',
      properties: {
        fetch: { type: 'boolean', description: 'Fetch origin before comparing, so ahead/behind is current (default true; pass false to read local refs only).' },
        full_access: { type: 'boolean', description: "Run the fetch with full file access, bypassing this session's sandbox file policy. Only set it with the user's explicit consent; the tool reports that it did." },
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
        branch: { type: 'string' },
        head: { type: 'string' },
        behind: { type: 'integer' },
        ahead: { type: 'integer' },
        fetched: { type: 'boolean' },
        dirtyCount: { type: 'integer' },
        dirtyFiles: { type: 'array', items: { type: 'string' } },
        untrackedCount: { type: 'integer' },
        untrackedFiles: { type: 'array', items: { type: 'string' } },
        version: { type: 'string' },
        binBuilt: { type: 'boolean' },
        launcherInstalled: { type: 'boolean' },
        launcherPath: { type: 'string' },
        serviceActive: { type: 'string' },
        serviceEnabled: { type: 'string' },
        serviceUnitInstalled: { type: 'boolean' },
        sandbox: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      let policy = resolvePolicy(ctx, exec)
      const repo = await repoRoot({ policy })
      const home = await homeDir({ policy })
      // `git fetch` is the one step of a status read that writes (FETCH_HEAD and
      // refs), so a checkout outside the session's writable roots would
      // otherwise surface as a confusing read-only failure instead of status.
      // Skip and disclose; full_access is the explicit way to still fetch.
      const fetchRequested = args.fetch !== false
      let wantFetch = fetchRequested
      let fetched = false
      let fetchNote = fetchRequested ? '' : ' (local refs; fetch=false)'
      let sandbox
      if (fetchRequested && policy !== undefined && !canWrite(policy, repo)) {
        const gate = await policyForWrites(ctx, exec, args, [repo], 'dsh_update_status')
        if (gate.refusal) {
          wantFetch = false
          const because = gate.refusal.outcome === 'unavailable'
            ? 'no approval channel is available'
            : `approval was ${gate.refusal.outcome}`
          fetchNote = ` (fetch skipped: ${policy.mode} cannot write ${repo}, ${because}; pass full_access=true with the user's consent, or widen the session policy)`
        } else {
          policy = gate.policy
          sandbox = sandboxField(gate)
        }
      }
      if (wantFetch) {
        // The count below compares against origin/master, which only advances on
        // a fetch: without one it reports "0 behind" for arbitrarily stale refs.
        const fetchR = await runCmd(`git -C ${repo} fetch origin`, { timeoutMs: 300000, policy })
        fetched = fetchR.exitCode === 0
        if (!fetched) fetchNote = ` (fetch failed: ${shortSummary(fetchR).slice(-200)})`
      }
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
      const statusLines = dirtyR.exitCode === 0 ? dirtyR.stdout.text.split('\n').filter(Boolean) : []
      const { tracked, untracked } = partitionStatus(statusLines)
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
        `origin/master: ${behind} behind, ${ahead} ahead${fetchNote}`,
        `dirty: ${tracked.length} tracked, ${untracked.length} untracked`,
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
        fetched,
        dirtyCount: tracked.length,
        dirtyFiles: tracked.slice(0, 20),
        untrackedCount: untracked.length,
        untrackedFiles: untracked.slice(0, 20),
        version,
        binBuilt,
        launcherInstalled,
        launcherPath: `${home}/.local/bin/dsh`,
        serviceActive: activeR.stdout.text.trim(),
        serviceEnabled: enabledR.stdout.text.trim(),
        serviceUnitInstalled,
        ...(sandbox ? { sandbox } : {}),
      }
    },
  }))

  // ── dsh_update ──────────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_update',
    description: 'Update the DeepSeek Harness checkout: git fetch + fast-forward pull, pnpm install, and a full build (pnpm run build), each as its own step. Refuses uncommitted tracked changes unless force=true (auto-stash before the pull, pop after); untracked files never block and are never stashed. Returns per-step exit codes and output tails. A build that fails on stale lib/ artifacts is retried once after pnpm run clean. After a successful build of new commits the dsh-web service is restarted to load them (pass restart=false to defer; the restart ends the calling session). It writes the checkout, so a session file policy that confines the checkout is refused up front with the escalation levers instead of failing mid-step; pass full_access=true (only with the user\'s explicit consent) to run this call outside the session sandbox.',
    parameters: {
      type: 'object',
      properties: {
        pull: { type: 'boolean', description: 'Run git fetch + fast-forward merge (default true).' },
        install: { type: 'boolean', description: 'Run pnpm install after the pull (default true).' },
        build: { type: 'boolean', description: 'Run pnpm run build after install (default true).' },
        test: { type: 'boolean', description: 'Also run pnpm run test after the build (default false; slow).' },
        force: { type: 'boolean', description: 'Proceed despite uncommitted tracked changes by auto-stashing them before the pull and popping after (default false; untracked files are never stashed).' },
        restart: { type: 'boolean', description: 'Restart the dsh-web service after a successful build of new commits so they load (default true; ends the calling session).' },
        full_access: { type: 'boolean', description: "Run this call's writes with full file access, bypassing this session's sandbox file policy. Only set it with the user's explicit consent; the result reports that it did." },
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
        restartScheduled: { type: 'boolean' },
        sandbox: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      const probe = resolvePolicy(ctx, exec)
      const repo = await repoRoot({ policy: probe })
      // The checkout is this tool's entire write surface, so gate it before any
      // step runs: a confining policy refuses here with the levers spelled out,
      // instead of surfacing as an opaque read-only failure inside `git fetch`.
      const gate = await policyForWrites(ctx, exec, args, [repo], 'dsh_update')
      if (gate.refusal) return refusalResult('dsh_update', gate.refusal, { repo })
      const policy = gate.policy
      const sandbox = gate.escalated ? sandboxField(gate) : undefined
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
          const statusLines = dirtyR.exitCode === 0 ? dirtyR.stdout.text.split('\n').filter(Boolean) : []
          const { tracked } = partitionStatus(statusLines)
          if (tracked.length > 0 && !force) {
            return {
              ok: false,
              summary: `working tree has ${tracked.length} tracked change(s); commit or run with force=true to auto-stash. First: ${tracked.slice(0, 5).join('; ')}`,
              repo,
              beforeHead,
              steps,
            }
          }
          if (tracked.length > 0) {
            // Tracked changes only: untracked paths do not block a fast-forward,
            // and `-u` would sweep unrelated work into the stash.
            const stash = await runCmd(`git -C ${repo} stash push -m dsh-selfup`, { timeoutMs: 60000, policy })
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
        const runBuild = async () => {
          const proc = startProc('pnpm run build', { workdir: repo, signal, policy })
          return waitProc(proc)
        }
        let rep = await runBuild()
        let note = ''
        if (rep.exitCode !== 0) {
          // A pull that renames or removes a package can leave stale `lib/`
          // bundles referencing removed exports, which breaks the build with
          // a MISSING_EXPORT error. Wipe build output and retry once; this only
          // fires on failure, so the common incremental build is untouched.
          const firstError = rep.delta.trim().slice(-400)
          const clean = await runCmd('pnpm run clean', { workdir: repo, timeoutMs: 180000, signal, policy })
          steps.push({
            name: 'pnpm run clean',
            ok: clean.exitCode === 0,
            exitCode: clean.exitCode === null ? -1 : clean.exitCode,
            detail: shortSummary(clean),
          })
          if (clean.exitCode === 0) {
            rep = await runBuild()
            note = `first build failed (${firstError}); cleaned + retried. `
          }
        }
        steps.push({
          name: 'pnpm run build',
          ok: rep.exitCode === 0,
          exitCode: rep.exitCode,
          detail: note + rep.delta.slice(-3000),
          spillPath: rep.spillPath,
        })
        if (rep.exitCode !== 0) {
          return { ok: false, summary: `pnpm run build failed${note ? ' (retry after clean also failed)' : ''}: ${rep.delta.slice(-1000)}`, repo, beforeHead, afterHead, steps }
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
      const changed = commits.length > 0
      const wantRestart = args.restart !== false
      let restartScheduled = false
      if (wantRestart && ok && needBuild && changed) {
        // The running web service loads its code at startup, so the new build
        // only takes effect on restart, and a stale-web-view plugin error
        // persists until it does. Schedule the restart a few seconds out so
        // this call returns its result before the session is terminated.
        const rr = await runCmd('systemd-run --user --on-active=5 -- systemctl --user restart dsh-web', { timeoutMs: 60000, policy })
        restartScheduled = rr.exitCode === 0
      }
      const restartNote = restartScheduled
        ? 'Restart scheduled; the web service is reloading the new code.'
        : changed && needBuild
          ? 'Restart the web service to apply the new code (dsh_systemd action=restart).'
          : ''
      return {
        ok,
        summary: `update ${ok ? 'succeeded' : 'finished with failures'}: ${beforeHead} -> ${afterHead} (${commits.length} new commit(s)).${restartNote ? ` ${restartNote}` : ''}`,
        repo,
        beforeHead,
        afterHead,
        commits,
        steps,
        restartScheduled,
        ...(sandbox ? { sandbox } : {}),
      }
    },
  }))

  // ── dsh_install ─────────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_install',
    description: 'Install the dsh CLI. mode=local (default): write a launcher to ~/.local/bin/dsh that execs the repo\'s built CLI (falling back to the source launcher) so `dsh` works from anywhere. mode=arch: generate a PKGBUILD for the published npm package and build it with makepkg, returning the package path to install with pacman. Both modes write outside the session workspace, so a file policy that confines it is refused up front; pass full_access=true with the user\'s explicit consent to proceed.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['local', 'arch'], description: 'local (default) writes ~/.local/bin/dsh; arch builds an Arch package.' },
        full_access: { type: 'boolean', description: "Run this call's writes with full file access, bypassing this session's sandbox file policy. Only set it with the user's explicit consent; the result reports that it did." },
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
        sandbox: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      const probe = resolvePolicy(ctx, exec)
      const mode = args.mode === 'arch' ? 'arch' : 'local'
      const repo = await repoRoot({ policy: probe })
      const home = await homeDir({ policy: probe })
      // local writes ~/.local/bin/dsh, arch writes ~/.cache/dsh-arch - both
      // outside a session workspace, so gate whichever this mode touches.
      const target = mode === 'arch' ? `${home}/.cache/dsh-arch` : `${home}/.local/bin/dsh`
      const gate = await policyForWrites(ctx, exec, args, [target], 'dsh_install')
      if (gate.refusal) return refusalResult('dsh_install', gate.refusal, { mode, path: target })
      const policy = gate.policy
      const sandbox = gate.escalated ? sandboxField(gate) : undefined
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
          ...(sandbox ? { sandbox } : {}),
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
        ...(sandbox ? { sandbox } : {}),
      }
    },
  }))

  // ── dsh_systemd ─────────────────────────────────────────────────────────────

  ctx.tools.register(toolDefinition({
    name: 'dsh_systemd',
    description: 'Manage a systemd USER service running the web UI (dsh-web). install writes ~/.config/systemd/user/dsh-web.service (ExecStart: ~/.local/bin/dsh web --host 127.0.0.1 --port 3080), daemon-reloads and enables it (does not start). start/restart/stop/disable/status act on the unit. NOTE: start/restart terminate the currently running dsh web instance - including the session this tool runs in - so the new code only takes effect then; the port must be free. Only install writes a file, and it lies outside the session workspace, so a file policy that confines it is refused up front; pass full_access=true with the user\'s explicit consent to proceed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'enable', 'disable', 'start', 'restart', 'stop'], description: 'What to do with the dsh-web user service.' },
        port: { type: 'integer', description: 'Listen port for the unit (default 3080).' },
        host: { type: 'string', description: 'Bind host for the unit (default 127.0.0.1).' },
        full_access: { type: 'boolean', description: "Run install's write with full file access, bypassing this session's sandbox file policy. Only set it with the user's explicit consent; the result reports that it did." },
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
        sandbox: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'summary'],
    },
    async execute(args, exec) {
      const probe = resolvePolicy(ctx, exec)
      const action = args.action
      const port = args.port ?? 3080
      const host = args.host ?? '127.0.0.1'
      const repo = await repoRoot({ policy: probe })
      const home = await homeDir({ policy: probe })
      const unitPath = `${home}/.config/systemd/user/dsh-web.service`
      const launcher = `${home}/.local/bin/dsh`
      // Only `install` writes a file (the unit, outside a session workspace);
      // the systemctl actions talk to the user manager over D-Bus and stay
      // available under a read-only policy.
      let policy = probe
      let sandbox
      if (action === 'install') {
        const gate = await policyForWrites(ctx, exec, args, [unitPath], 'dsh_systemd')
        if (gate.refusal) return refusalResult('dsh_systemd', gate.refusal, { action, unitPath })
        policy = gate.policy
        sandbox = gate.escalated ? sandboxField(gate) : undefined
      }
      const node = await nodePath({ policy })

      if (action === 'install') {
        const check = await runCmd(`test -x ${launcher} && echo yes || echo no`, { timeoutMs: 15000, policy })
        if (check.stdout.text.trim() !== 'yes') {
          return { ok: false, summary: `${launcher} missing - run dsh_install mode=local first.`, action, unitPath }
        }
        const nodeDir = node.includes('/') ? node.slice(0, node.lastIndexOf('/')) : ''
        // Inherit the graphical session's display so the harness's native
        // directory picker (auto-resolver: DISPLAY/WAYLAND_DISPLAY + zenity)
        // serves `native` instead of falling back to `browse`, which breaks
        // host.pickDirectory for workspace creation. Absent display vars
        // (headless) simply produce no Environment line.
        const displayR = await runCmd('printf "%s" "$DISPLAY"', { timeoutMs: 15000, policy })
        const waylandR = await runCmd('printf "%s" "$WAYLAND_DISPLAY"', { timeoutMs: 15000, policy })
        const display = displayR.exitCode === 0 ? displayR.stdout.text.trim() : ''
        const wayland = waylandR.exitCode === 0 ? waylandR.stdout.text.trim() : ''
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
          ...(display !== '' ? [`Environment=DISPLAY=${display}`] : []),
          ...(wayland !== '' ? [`Environment=WAYLAND_DISPLAY=${wayland}`] : []),
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
          ...(sandbox ? { sandbox } : {}),
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
        ...(sandbox ? { sandbox } : {}),
      }
    },
  }))
}
