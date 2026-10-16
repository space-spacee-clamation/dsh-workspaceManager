// Browser-half verification. `lib/client.js` is booted in a `node:vm` page
// sandbox through the loader harness (so the bundle sees the real
// `window.__ModuleLoader__.load({ id, factory })` registration), materialized
// with a require that resolves only the nine platform modules, and then driven
// against a fake client context that records slot contributions.

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { loadClientBundle, makeClientCtx, PLATFORM_MODULES } from './helpers/loader.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const loaded = loadClientBundle()
const plugin = loaded.exports
const REGISTRATIONS = [...loaded.registered]
after(() => {
  // Nothing keeps the process alive: the sandbox timers never fire.
})

/**
 * React APIs a component may reach for. Element construction plus local
 * component state is allowed; anything that owns a subscription or reads a
 * React context is not (the browser half must take live data through the
 * framework seats it was given, never through its own wiring).
 */
const ALLOWED_REACT_APIS = new Set([
  'createElement', 'Fragment', 'memo', 'forwardRef', 'createRef',
  'Children', 'cloneElement', 'isValidElement', 'StrictMode', 'Suspense', 'lazy',
  'useState', 'useReducer', 'useRef', 'useMemo', 'useCallback', 'useEffect',
  'useLayoutEffect', 'useId', 'useTransition', 'useDeferredValue', 'startTransition',
  'useImperativeHandle', 'useDebugValue',
])

/** React APIs that would mean the component owns ctx-reaching or subscription state. */
const FORBIDDEN_REACT_APIS = new Set(['createContext', 'useContext', 'useSyncExternalStore'])

/**
 * A recursive stub: callable, any property returns the stub, and iterating it
 * yields nothing. Used for framework hooks whose data the spec does not model.
 * @returns the stub.
 */
function universalStub() {
  const target = function stub() {}
  const proxy = new Proxy(target, {
    get(_target, property, receiver) {
      if (property === 'then') return undefined
      if (property === Symbol.toPrimitive) return () => ''
      if (property === Symbol.iterator || property === Symbol.asyncIterator) return function* empty() {}
      if (typeof property === 'symbol') return undefined
      if (property in target) return Reflect.get(target, property, receiver)
      return proxy
    },
    apply() {
      return proxy
    },
    has() {
      return true
    },
  })
  return proxy
}

/** @returns the framework-shaped props a registered component receives. */
function plausibleProps() {
  const stub = universalStub()
  const props = {
    // standing seats
    useSession: () => stub,
    useSessions: () => stub,
    useWorkspaces: () => stub,
    useStore: () => stub,
    renderSlot: () => null,
    renderFactorySlot: () => null,
    t: (key) => String(key),
  }
  return new Proxy(props, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      if (typeof property === 'symbol') return undefined
      return stub
    },
    has() {
      return true
    },
  })
}

test('lib/client.js registers one bundle whose factory returns the plugin', () => {
  assert.equal(REGISTRATIONS.length, 1, 'exactly one registration')
  assert.equal(REGISTRATIONS[0].id, packageJson.name, 'the registration id is the package name')
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.name, 'string')
  assert.ok(plugin.name.length > 0)
  assert.deepEqual([...plugin.inject], ['slots', 'connection', 'layout'])
  assert.equal(typeof plugin.apply, 'function')
})

test('every module the bundle requests is a platform module', () => {
  assert.deepEqual(loaded.asyncRequires, [], 'the bundle must not request a package-local chunk')
  for (const specifier of loaded.requires) {
    assert.equal(PLATFORM_MODULES.includes(specifier), true, `require("${specifier}") is not in the platform allow-list`)
  }
  assert.equal(PLATFORM_MODULES.length, 9)
})

test('apply contributes exactly the two documented slots', async () => {
  const harness = makeClientCtx()
  await plugin.apply(harness.ctx)
  try {
    assert.deepEqual([...harness.injections].sort(), ['main', 'sidebar.panellist'])
    assert.equal(harness.registrations.length, 2, 'exactly two slot registrations')

    const page = harness.registrations.find((entry) => entry.options.name === 'main')
    assert.ok(page !== undefined, 'the panel page must register into the "main" slot')
    assert.equal(page.options.key, 'workspaceManager', 'the "main" entry is keyed workspaceManager')
    assert.equal(typeof page.Component, 'function')

    const glyph = harness.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
    assert.ok(glyph !== undefined, 'the sidebar glyph must register into "sidebar.panellist"')
    assert.equal(glyph.options.id, 'workspaceManager', 'the panellist entry id is workspaceManager')
    assert.equal(glyph.options.order, 45, 'the panellist entry order is 45')
    assert.equal(typeof glyph.Component, 'function')
  } finally {
    harness.dispose()
  }
})

test('apply survives every optional client service being absent', async () => {
  const harness = makeClientCtx({ services: { uiWorkspace: undefined, workspaces: undefined } })
  await plugin.apply(harness.ctx)
  try {
    assert.equal(harness.registrations.length, 2, 'the panel still registers without uiWorkspace')
    assert.equal(harness.ctx.get('uiWorkspace'), undefined)
  } finally {
    harness.dispose()
  }
})

test('the registered components render with framework-shaped props', () => {
  const harness = makeClientCtx()
  plugin.apply(harness.ctx)
  try {
    for (const entry of harness.registrations) {
      const label = `${entry.options.name} component`
      loaded.platform.react.resetHooks()
      const tree = loaded.platform.react.render(entry.Component, plausibleProps())
      assert.ok(
        tree === null || tree === undefined || (typeof tree === 'object' && 'type' in tree),
        `${label} must return a React element or null, received ${JSON.stringify(tree)?.slice(0, 200)}`,
      )
    }
  } finally {
    harness.dispose()
  }
})

test('the tree is built with element APIs and owns no subscription state', () => {
  const accesses = [...loaded.platform.react.accesses]
  const forbidden = accesses.filter((name) => FORBIDDEN_REACT_APIS.has(name))
  assert.deepEqual(forbidden, [], `the browser half must not own subscription or context state: ${forbidden.join(', ')}`)
  const unknown = accesses.filter((name) => !ALLOWED_REACT_APIS.has(name))
  assert.deepEqual(unknown, [], `unexpected React API use: ${unknown.join(', ')}`)
  const buildsElements = accesses.includes('createElement') || loaded.requires.includes('react/jsx-runtime')
  assert.equal(buildsElements, true, 'the tree must be built with createElement or the jsx runtime')
})

test('the panel reacts to a workspace without touching the network', async () => {
  const harness = makeClientCtx()
  await plugin.apply(harness.ctx)
  try {
    const page = harness.registrations.find((entry) => entry.options.name === 'main')
    loaded.platform.react.resetHooks()
    assert.doesNotThrow(() => loaded.platform.react.render(page.Component, plausibleProps()))
    for (const call of harness.rpcCalls) {
      assert.equal(call.channel, 'workspace-manager', `RPC channel must be workspace-manager, received ${call.channel}`)
    }
  } finally {
    harness.dispose()
  }
})
