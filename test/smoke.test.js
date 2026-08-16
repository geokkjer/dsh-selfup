/**
 * dsh-selfup smoke tests: apply the plugin against a stub context and assert
 * the four tools register with the expected names and well-formed JSON schemas.
 * No harness is required — the plugin's shell usage is exercised only at tool
 * execution time, which these tests do not trigger.
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
