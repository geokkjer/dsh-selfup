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
