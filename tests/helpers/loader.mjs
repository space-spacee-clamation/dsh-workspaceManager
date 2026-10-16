// Test infrastructure for the browser half: `lib/client.js` is evaluated with
// `node:vm` in a page-shaped sandbox exactly as the web shell does it — the
// script only REGISTERS a factory through `window.__ModuleLoader__.load(...)`;
// materialization happens on the first `require`, which may name only the nine
// platform modules the shell seeds. A specifier outside that set throws here
// for the same reason it would throw in the page.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/** Module specifiers the shell seeds into the frozen module table. */
export const PLATFORM_MODULES = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/**
 * Minimal React stand-in. Hooks are positional cells that survive a re-render,
 * so a component written against the framework seats can be called directly;
 * `createElement` produces a plain element record.
 * @returns the stub plus render helpers and the recorded API accesses.
 */
export function createReactStub() {
  let cursor = 0
  const cells = []
  const pending = []
  const accesses = new Set()

  const flush = () => {
    const queued = pending.splice(0, pending.length)
    for (const effect of queued) effect()
  }
  const element = (type, props, children) => ({
    $$typeof: Symbol.for('react.element'),
    type,
    props: { ...(props ?? {}), ...(children.length > 0 ? { children: children.length === 1 ? children[0] : children } : {}) },
    children,
  })
  const flat = (children) => children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)

  const react = {
    Fragment: Symbol.for('react.fragment'),
    StrictMode: Symbol.for('react.strict_mode'),
    Suspense: Symbol.for('react.suspense'),
    createElement(type, props, ...children) {
      return element(type, props, flat(children))
    },
    cloneElement(node, props, ...children) {
      return element(node.type, { ...node.props, ...props }, flat(children))
    },
    isValidElement(value) {
      return typeof value === 'object' && value !== null && '$$typeof' in value
    },
    createRef() {
      return { current: null }
    },
    forwardRef(render) {
      return render
    },
    memo(component) {
      return component
    },
    lazy(factory) {
      return factory
    },
    Children: {
      toArray: (children) => (Array.isArray(children) ? children : children === undefined || children === null ? [] : [children]),
      map: (children, fn) => (Array.isArray(children) ? children : [children]).map(fn),
      count: (children) => (Array.isArray(children) ? children.length : children === undefined || children === null ? 0 : 1),
    },
    createContext(defaultValue) {
      return { Provider: Symbol.for('react.provider'), Consumer: Symbol.for('react.consumer'), _currentValue: defaultValue }
    },
    useContext(context) {
      cursor += 1
      return context?._currentValue
    },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
    },
    useReducer(reducer, initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (action) => { cells[index] = reducer(cells[index], action) }]
    },
    useMemo(compute) {
      cursor += 1
      return compute()
    },
    useCallback(callback) {
      cursor += 1
      return callback
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    useEffect(effect) {
      cursor += 1
      pending.push(effect)
    },
    useLayoutEffect(effect) {
      cursor += 1
      pending.push(effect)
    },
    useImperativeHandle() {
      cursor += 1
    },
    useDebugValue() {
      cursor += 1
    },
    useId() {
      return `:r${cursor++}:`
    },
    useTransition() {
      cursor += 1
      return [false, (fn) => fn()]
    },
    useDeferredValue(value) {
      cursor += 1
      return value
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor += 1
      return getSnapshot()
    },
    startTransition(fn) {
      fn()
    },
  }

  return {
    react,
    accesses,
    /** @param component - component function. @param props - props. @returns the rendered tree. */
    render(component, props) {
      cursor = 0
      const tree = component(props)
      flush()
      return tree
    },
    rerender(component, props) {
      cursor = 0
      const tree = component(props)
      flush()
      return tree
    },
    resetHooks() {
      cursor = 0
      cells.length = 0
      pending.length = 0
    },
    flushEffects: flush,
  }
}

/** @returns a stub whose every unknown member is a no-op component function. */
function autoStub(label, overrides = {}) {
  const cache = new Map()
  return new Proxy(overrides, {
    get(target, property) {
      if (property === 'then') return undefined
      if (property in target) return target[property]
      if (typeof property !== 'string') return undefined
      if (!cache.has(property)) {
        const member = function StubComponent() { return null }
        Object.defineProperty(member, 'name', { value: `${label}.${property}` })
        cache.set(property, member)
      }
      return cache.get(property)
    },
    has() {
      return true
    },
  })
}

/** @returns a minimal `document` that records appended style elements. */
function createDocumentStub() {
  const elements = []
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      textContent: '',
      children: [],
      attributes: {},
      style: {},
      setAttribute(name, value) { node.attributes[name] = String(value) },
      getAttribute(name) { return node.attributes[name] },
      removeAttribute(name) { delete node.attributes[name] },
      appendChild(child) { node.children.push(child); elements.push(child); return child },
      removeChild(child) { const at = node.children.indexOf(child); if (at >= 0) node.children.splice(at, 1); return child },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    return node
  }
  const head = make('head')
  const body = make('body')
  return {
    head,
    body,
    documentElement: make('html'),
    createElement: make,
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) => elements.find((node) => node.id === id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    elements,
  }
}

/** @returns a `localStorage` double. */
function createStorageStub() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)) },
    removeItem: (key) => { store.delete(String(key)) },
    clear: () => { store.clear() },
    get length() { return store.size },
  }
}

/**
 * Create the page sandbox, the `__ModuleLoader__` facade and the platform
 * module table.
 * @returns `{ sandbox, registrations, loader, platform, requires, asyncRequires }`.
 */
function createPlatform() {
  const reactStub = createReactStub()
  const observed = new Proxy(reactStub.react, {
    get(target, property, receiver) {
      if (typeof property === 'string') reactStub.accesses.add(property)
      return Reflect.get(target, property, receiver)
    },
  })
  const jsxRuntime = {
    Fragment: reactStub.react.Fragment,
    jsx: (type, props) => {
      const { children, ...rest } = props ?? {}
      return reactStub.react.createElement(type, rest, ...(children === undefined ? [] : [children]))
    },
    jsxs: (type, props) => {
      const { children, ...rest } = props ?? {}
      return reactStub.react.createElement(type, rest, ...(children === undefined ? [] : [children]))
    },
    jsxDEV: (type, props) => {
      const { children, ...rest } = props ?? {}
      return reactStub.react.createElement(type, rest, ...(children === undefined ? [] : [children]))
    },
  }
  const store = {
    createSnapshotStore(initial) {
      let state = typeof initial === 'function' ? initial() : initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        set: (next) => {
          state = typeof next === 'function' ? next(state) : next
          for (const listener of [...listeners]) listener()
        },
        get: () => state,
      }
    },
    defineStore: (definition) => definition,
    shallowEqual: (left, right) => {
      if (left === right) return true
      if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
      const keys = Object.keys(left)
      if (keys.length !== Object.keys(right).length) return false
      return keys.every((key) => left[key] === right[key])
    },
  }
  const modules = {
    'react': observed,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': autoStub('react-dom', { createPortal: (children) => children }),
    'react-dom/client': autoStub('react-dom/client', { createRoot: () => ({ render() {}, unmount() {} }) }),
    '@deepseek-ai/cordis': autoStub('cordis', { Service: class Service {}, Context: class Context {} }),
    '@deepseek-ai/dsh-client-store': autoStub('client-store', store),
    '@deepseek-ai/dsh-client-ui-slots': autoStub('ui-slots'),
    '@deepseek-ai/dsh-client-ui-primitives': autoStub('ui-primitives'),
    '@deepseek-ai/dsh-client-ui-dockkit': autoStub('ui-dockkit'),
  }
  return { modules, react: reactStub }
}

/**
 * Load one built client bundle the way the web shell loads it: evaluate the
 * script in a page sandbox, then materialize its registered factory with a
 * require that resolves only platform modules.
 * @param file - bundle path; defaults to this package's `lib/client.js`.
 * @returns `{ exports, requires, asyncRequires, registered, registration, sandbox, platform }`.
 */
export function loadClientBundle(file = path.join(ROOT, 'lib', 'client.js')) {
  const source = fs.readFileSync(file, 'utf8')
  const registrations = []
  const platform = createPlatform()
  const document = createDocumentStub()
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    document,
    navigator: { userAgent: 'dsh-client-test', clipboard: { writeText: async () => {} } },
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', protocol: 'http:' },
    localStorage: createStorageStub(),
    // Timers never fire: no spec may depend on a page timer, and none may keep
    // the test process alive.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    queueMicrotask: (fn) => { queueMicrotask(fn) },
    fetch: async () => { throw new Error('network access is forbidden in tests') },
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
  }
  const loader = {
    mode: 'queue',
    pendingQueue: registrations,
    load(registration) {
      registrations.push(registration)
    },
    create() {
      throw new Error('this harness does not create the client module system')
    },
  }
  sandbox.__ModuleLoader__ = loader
  sandbox.__DSH_BOOT__ = { rev: 'harness', entries: [], batches: [] }
  sandbox.window = sandbox
  sandbox.self = sandbox

  const context = vm.createContext(sandbox, { name: 'dsh-client-bundle' })
  vm.runInContext(source, context, { filename: file, displayErrors: true })
  if (registrations.length === 0) {
    throw new Error(`${file} did not call window.__ModuleLoader__.load(...)`)
  }
  const registration = registrations[registrations.length - 1]
  if (typeof registration.factory !== 'function') {
    throw new Error(`${file} registered a bundle without a factory function`)
  }

  const requires = []
  const asyncRequires = []
  const requireModule = (specifier) => {
    requires.push(specifier)
    if (!PLATFORM_MODULES.includes(specifier)) {
      throw new Error(`client bundle required "${specifier}", which is not a platform module`)
    }
    return platform.modules[specifier]
  }
  requireModule.async = async (specifier) => {
    asyncRequires.push(specifier)
    throw new Error(`client bundle requested the package-local chunk "${specifier}"`)
  }

  const exports = registration.factory(requireModule)
  return { exports, requires, asyncRequires, registered: registrations, registration, sandbox, platform, context }
}

/**
 * A fake client context: records slot injections/registrations as the renderer
 * would, answers RPC with plausible payloads, and exposes optional services
 * through `ctx.get`.
 * @param options - `services` overrides `ctx.get`; `rpc` overrides endpoint handling.
 * @returns the harness.
 */
export function makeClientCtx(options = {}) {
  const injections = []
  const registrations = []
  const disposers = []
  const panels = []
  const rpcCalls = []
  const services = {
    uiWorkspace: {
      startSession: (workspaceId) => { services.uiWorkspace.calls.push({ op: 'startSession', workspaceId }) },
      openWorkspace: (workspaceId) => { services.uiWorkspace.calls.push({ op: 'openWorkspace', workspaceId }) },
      pickDirectory: async () => '/tmp/picked',
      listDirectory: async () => [],
      calls: [],
    },
    ...(options.services ?? {}),
  }
  const plausible = {
    state: () => ({
      repos: [],
      items: [],
      jobs: [],
      settings: {
        defaultParentDir: '', directoryTemplate: '{repo}-{name}', branchPrefix: '', cloneDepth: 0,
        partialClone: false, fetchBeforeCreate: false, deleteDirectoryOnArchive: false,
        autoOpenSession: false, concurrency: 1,
      },
      stores: { file: '', writeError: null, gitPath: null, gitVersion: null },
    }),
    'jobs/list': () => ({ jobs: [] }),
    'repos/branches': () => ({ branches: ['main'], head: 'main' }),
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    /** @param name - service name. @returns the service or undefined. */
    get: (name) => services[name],
    /** @param fn - effect body. @returns its disposer. */
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(wrapped)
      return wrapped
    },
    on() {
      return () => {}
    },
    layout: {
      /** @param id - panel id brought forward. */
      selectPanel(id) {
        panels.push(id)
      },
    },
    connection: {
      rpc: {
        /**
         * @param channel - RPC channel.
         * @param endpoint - RPC method.
         * @param payload - request payload.
         * @returns the response envelope.
         */
        async call(channel, endpoint, payload) {
          rpcCalls.push({ channel, endpoint, payload })
          if (typeof options.rpc === 'function') return options.rpc(channel, endpoint, payload)
          const value = plausible[endpoint] === undefined ? {} : plausible[endpoint](payload)
          return { ok: true, value }
        },
      },
    },
    slots: {
      /**
       * @param name - slot name being contributed into.
       * @param callback - registration body; may be a generator of disposers.
       * @returns the disposer.
       */
      inject(name, callback) {
        injections.push(name)
        const result = callback()
        if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
          for (const disposer of result) if (typeof disposer === 'function') disposers.push(disposer)
        } else if (typeof result === 'function') {
          disposers.push(result)
        }
        return () => {}
      },
      /**
       * @param registrationOptions - `{ name, key }` or `{ name, id, order }`.
       * @param component - the contributed component.
       * @returns the disposer.
       */
      register(registrationOptions, component) {
        const entry = { options: registrationOptions, Component: component }
        registrations.push(entry)
        const dispose = () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
  }

  return {
    ctx,
    services,
    injections,
    registrations,
    panels,
    rpcCalls,
    /** Run every recorded disposer, as unloading the plugin fiber would. */
    dispose() {
      for (const dispose of disposers.splice(0, disposers.length)) {
        try {
          dispose()
        } catch {
          // A disposer throwing is not what a spec asserts here.
        }
      }
    },
  }
}
