/**
 * dsh-selfup smoke tests: apply the plugin against a stub context and assert
 * the four tools register with the expected names and well-formed JSON schemas.
 * No harness is required — the registration tests never invoke a tool's
 * execute path; the build-failure tests below drive shell.start/run with
 * scripted responses to exercise dsh_update's clean-and-retry fallback.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply } from '../index.js'

/** Minimal stub: a tool registry plus the optional-service getter. */
function stubContext() {
  const tools = []
  return {
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
    get: () => undefined,
    shell: {
      resolve: (request) => request,
      run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }),
    },
    _tools: tools,
  }
}

/** A background-process value shaped like what waitProc consumes. */
function makeProc(exitCode, delta = '') {
  return {
    done: Promise.resolve(),
    exitCode,
    signal: null,
    readOutput: () => ({ delta, lossy: false, stdoutSpillPath: '', stderrSpillPath: '' }),
  }
}

/** A successful `shell.run` result carrying `text` on stdout. */
function okText(text = '') {
  return { exitCode: 0, stdout: { text }, stderr: { text: '' } }
}

/**
 * A context whose `shell.run` answers the commands `dsh_update_status` issues,
 * recording every command so a test can assert on the fetch it did or skipped.
 * @param options - scripted counts, porcelain lines, and fetch exit code.
 * @returns the stub context plus the recorded command list on `_seen`.
 */
function statusContext({ statusLines = [], count = '0\t0', fetchExit = 0 } = {}) {
  const ctx = stubContext()
  const seen = []
  ctx.shell.run = async (spec) => {
    const cmd = spec.command
    seen.push(cmd)
    if (cmd.includes('fetch origin')) {
      return { exitCode: fetchExit, stdout: { text: '' }, stderr: { text: fetchExit === 0 ? '' : 'network unreachable' } }
    }
    if (cmd.includes('rev-parse --show-toplevel')) return okText('/repo')
    if (cmd.includes('symbolic-ref')) return okText('master')
    if (cmd.includes('log -1 --format')) return okText('abc123 a commit')
    if (cmd.includes('rev-list --left-right --count')) return okText(count)
    if (cmd.includes('status --porcelain')) return okText(statusLines.length ? `${statusLines.join('\n')}\n` : '')
    if (cmd.includes('grep -m1')) return okText('  "version": "9.9.9",')
    return okText('')
  }
  ctx._seen = seen
  return ctx
}

test('plugin exposes the expected identity', () => {
  assert.equal(name, 'dsh-selfup')
  assert.deepEqual(inject, ['tools', 'shell'])
})

test('apply registers exactly the four maintenance tools', () => {
  const ctx = stubContext()
  apply(ctx)
  const names = ctx._tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['dsh_install', 'dsh_systemd', 'dsh_update', 'dsh_update_status'])
})

test('every tool declares lossless JSON parameters and an output renderer', () => {
  const ctx = stubContext()
  apply(ctx)
  for (const tool of ctx._tools) {
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name} parameters must be an object`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be object-rooted`)
    assert.equal(typeof tool.output, 'object', `${tool.name} needs output`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} needs a render function`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs an execute function`)
    const rendered = tool.output.render({}, { ok: true, summary: 'hello' })
    assert.ok(Array.isArray(rendered), `${tool.name} render must return an array`)
    assert.equal(rendered[0].type, 'text', `${tool.name} render must return text blocks`)
  }
})

test('dsh_systemd requires the action parameter', () => {
  const ctx = stubContext()
  apply(ctx)
  const systemd = ctx._tools.find((tool) => tool.name === 'dsh_systemd')
  assert.ok(systemd.parameters.required.includes('action'), 'action must be required')
  assert.ok(systemd.parameters.properties.action.enum.includes('restart'))
})

test('dsh_install offers local and arch modes', () => {
  const ctx = stubContext()
  apply(ctx)
  const install = ctx._tools.find((tool) => tool.name === 'dsh_install')
  assert.deepEqual(install.parameters.properties.mode.enum, ['local', 'arch'])
})

test('dsh_update cleans and retries the build after a stale-artifact failure', async () => {
  let buildAttempts = 0
  let cleaned = false
  const ctx = stubContext()
  ctx.shell.start = (spec) => {
    if (spec.command === 'pnpm run build') {
      buildAttempts += 1
      return buildAttempts === 1
        ? makeProc(1, 'MISSING_EXPORT "FIRST_PARTY_SECTION_ORDER" is not exported')
        : makeProc(0, 'build ok')
    }
    return makeProc(0, '')
  }
  ctx.shell.run = async (spec) => {
    if (spec.command === 'pnpm run clean') {
      cleaned = true
      return { exitCode: 0, stdout: { text: 'clean: removed 267 paths' }, stderr: { text: '' } }
    }
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({}, {})
  assert.equal(result.ok, true)
  assert.equal(cleaned, true)
  assert.equal(buildAttempts, 2)
  const build = result.steps.find((s) => s.name === 'pnpm run build')
  assert.equal(build.ok, true)
  assert.ok(build.detail.startsWith('first build failed'))
  assert.ok(result.steps.some((s) => s.name === 'pnpm run clean' && s.ok))
})

test('dsh_update does not clean when the build succeeds on the first attempt', async () => {
  let buildAttempts = 0
  let cleaned = false
  const ctx = stubContext()
  ctx.shell.start = (spec) => {
    if (spec.command === 'pnpm run build') {
      buildAttempts += 1
      return makeProc(0, 'build ok')
    }
    return makeProc(0, '')
  }
  ctx.shell.run = async (spec) => {
    if (spec.command === 'pnpm run clean') {
      cleaned = true
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    }
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({}, {})
  assert.equal(result.ok, true)
  assert.equal(cleaned, false)
  assert.equal(buildAttempts, 1)
  assert.equal(result.steps.some((s) => s.name === 'pnpm run clean'), false)
})

test('dsh_update schedules a web-service restart after building new commits', async () => {
  let restartCalls = 0
  const ctx = stubContext()
  ctx.shell.start = (spec) => {
    if (spec.command === 'pnpm run build') return makeProc(0, 'build ok')
    return makeProc(0, '')
  }
  ctx.shell.run = async (spec) => {
    const cmd = spec.command
    if (cmd.includes('log --oneline')) return { exitCode: 0, stdout: { text: 'a1b2c3 new code' }, stderr: { text: '' } }
    if (cmd.includes('systemd-run')) { restartCalls += 1; return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } } }
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({}, {})
  assert.equal(result.ok, true)
  assert.equal(result.restartScheduled, true)
  assert.equal(restartCalls, 1)
})

test('dsh_update skips the restart when restart=false', async () => {
  let restartCalls = 0
  const ctx = stubContext()
  ctx.shell.start = (spec) => makeProc(0, 'build ok')
  ctx.shell.run = async (spec) => {
    const cmd = spec.command
    if (cmd.includes('log --oneline')) return { exitCode: 0, stdout: { text: 'a1b2c3 new code' }, stderr: { text: '' } }
    if (cmd.includes('systemd-run')) { restartCalls += 1; return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } } }
    return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({ restart: false }, {})
  assert.equal(result.ok, true)
  assert.equal(result.restartScheduled, false)
  assert.equal(restartCalls, 0)
})

test('dsh_update_status fetches origin so ahead/behind reflects the real remote', async () => {
  const ctx = statusContext({ count: '666\t0' })
  apply(ctx)
  const status = ctx._tools.find((tool) => tool.name === 'dsh_update_status')
  const result = await status.execute({}, {})
  assert.equal(result.fetched, true)
  assert.equal(result.behind, 666)
  assert.equal(result.ahead, 0)
  assert.ok(ctx._seen.some((cmd) => cmd.includes('fetch origin')), 'status must fetch before comparing')
  const fetchAt = ctx._seen.findIndex((cmd) => cmd.includes('fetch origin'))
  const countAt = ctx._seen.findIndex((cmd) => cmd.includes('rev-list --left-right --count'))
  assert.ok(fetchAt < countAt, 'the fetch must precede the count it feeds')
  assert.ok(result.summary.includes('666 behind'))
})

test('dsh_update_status skips the fetch when fetch=false', async () => {
  const ctx = statusContext({ count: '0\t0' })
  apply(ctx)
  const status = ctx._tools.find((tool) => tool.name === 'dsh_update_status')
  const result = await status.execute({ fetch: false }, {})
  assert.equal(result.fetched, false)
  assert.equal(ctx._seen.some((cmd) => cmd.includes('fetch origin')), false)
  assert.ok(result.summary.includes('fetch=false'), 'the summary must disclose stale refs')
})

test('dsh_update_status reports a failed fetch rather than implying it is current', async () => {
  const ctx = statusContext({ count: '0\t0', fetchExit: 128 })
  apply(ctx)
  const status = ctx._tools.find((tool) => tool.name === 'dsh_update_status')
  const result = await status.execute({}, {})
  assert.equal(result.fetched, false)
  assert.equal(result.ok, true)
  assert.ok(result.summary.includes('fetch failed'))
})

test('dsh_update_status reports tracked and untracked files separately', async () => {
  const ctx = statusContext({ statusLines: [' M packages/a.ts', '?? voice-research/'] })
  apply(ctx)
  const status = ctx._tools.find((tool) => tool.name === 'dsh_update_status')
  const result = await status.execute({}, {})
  assert.equal(result.dirtyCount, 1)
  assert.deepEqual(result.dirtyFiles, [' M packages/a.ts'])
  assert.equal(result.untrackedCount, 1)
  assert.deepEqual(result.untrackedFiles, ['?? voice-research/'])
  assert.ok(result.summary.includes('1 tracked, 1 untracked'))
})

test('dsh_update proceeds when only untracked files are present', async () => {
  const stashes = []
  const merges = []
  const ctx = stubContext()
  ctx.shell.start = () => makeProc(0, 'build ok')
  ctx.shell.run = async (spec) => {
    const cmd = spec.command
    if (cmd.includes('rev-list --count HEAD..origin/master')) return okText('3')
    if (cmd.includes('status --porcelain')) return okText('?? voice-research/\n')
    if (cmd.includes('stash')) { stashes.push(cmd); return okText('') }
    if (cmd.includes('merge --ff-only')) { merges.push(cmd); return okText('') }
    if (cmd.includes('log --oneline')) return okText('a1b2c3 new code')
    return okText('')
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({ restart: false }, {})
  assert.equal(result.ok, true)
  assert.equal(stashes.length, 0, 'untracked files must not be stashed')
  assert.equal(merges.length, 1, 'the fast-forward must still run')
})

test('dsh_update refuses uncommitted tracked changes without force', async () => {
  const stashes = []
  const ctx = stubContext()
  ctx.shell.start = () => makeProc(0, 'build ok')
  ctx.shell.run = async (spec) => {
    const cmd = spec.command
    if (cmd.includes('rev-list --count HEAD..origin/master')) return okText('3')
    if (cmd.includes('status --porcelain')) return okText(' M packages/core/session/src/index.ts\n?? notes/\n')
    if (cmd.includes('stash')) { stashes.push(cmd); return okText('') }
    return okText('')
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({ restart: false }, {})
  assert.equal(result.ok, false)
  assert.ok(result.summary.includes('1 tracked change'))
  assert.equal(stashes.length, 0)
})

test('dsh_update force stashes tracked changes without sweeping untracked files', async () => {
  const stashes = []
  const ctx = stubContext()
  ctx.shell.start = () => makeProc(0, 'build ok')
  ctx.shell.run = async (spec) => {
    const cmd = spec.command
    if (cmd.includes('rev-list --count HEAD..origin/master')) return okText('3')
    if (cmd.includes('status --porcelain')) return okText(' M index.js\n?? notes/\n')
    if (cmd.includes('stash push')) { stashes.push(cmd); return okText('') }
    if (cmd.includes('log --oneline')) return okText('a1b2c3 new code')
    return okText('')
  }
  apply(ctx)
  const update = ctx._tools.find((tool) => tool.name === 'dsh_update')
  const result = await update.execute({ restart: false, force: true }, {})
  assert.equal(result.ok, true)
  assert.equal(stashes.length, 1)
  assert.equal(stashes[0].includes(' -u'), false, 'untracked files must never be stashed')
  assert.equal(stashes[0].includes('--include-untracked'), false)
})
