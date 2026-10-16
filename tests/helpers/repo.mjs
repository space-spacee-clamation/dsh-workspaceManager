// Test infrastructure shared by the suites: a throwaway git fixture under
// `os.tmpdir()`, filesystem helpers, and fakes for the Host-side capabilities
// the plugin reaches through `ctx.get` (`webServer`, `connection`,
// `workspaceRegistry`, `subprocess`, `logger`). Nothing here touches the
// network, the user's profile, or any path outside a temp directory.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HERMETIC_GIT_ENV } from './subprocess.mjs'

/**
 * @param prefix - mkdtemp prefix.
 * @returns a fresh canonical directory under `os.tmpdir()`. The path is
 *   realpath-normalized (Windows short names expand) so a path comparison
 *   against an implementation that canonicalizes its own input still matches.
 */
export function tempDir(prefix = 'dsh-wm-') {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return fs.realpathSync.native(created)
  } catch {
    return created
  }
}

/** @param target - directory to delete. Best-effort recursive removal with retries. */
export function removeDir(target) {
  if (typeof target !== 'string' || target.length === 0) return
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 })
}

/**
 * Run one callback against a fresh temp directory and always remove it.
 * @param fn - receives the directory; may be async.
 * @param prefix - mkdtemp prefix.
 * @returns whatever `fn` returned.
 */
export async function withTempDir(fn, prefix = 'dsh-wm-') {
  const dir = tempDir(prefix)
  try {
    return await fn(dir)
  } finally {
    removeDir(dir)
  }
}

/** @param target - path to test. @returns whether it exists. */
export function exists(target) {
  return fs.existsSync(target)
}

/**
 * Read and parse a JSON file.
 * @param file - path to read.
 * @returns the parsed value.
 */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** @param ms - milliseconds to wait. @returns a promise resolving after the delay. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Point HOME/USERPROFILE (and the XDG roots) at a temp directory so a Host half
 * that derives its storage path from the home directory cannot touch the real
 * user profile. Call once per spec file and restore in a final hook.
 * @returns `{ home, restore }`.
 */
export function isolateHome() {
  const home = tempDir('dsh-wm-home-')
  const saved = new Map()
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    saved.set(key, process.env[key])
    process.env[key] = key.startsWith('XDG') ? path.join(home, key.slice(4).toLowerCase()) : home
  }
  return {
    home,
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      removeDir(home)
    },
  }
}

/**
 * Run git synchronously against the hermetic fixture environment.
 * @param args - git arguments.
 * @param cwd - working directory.
 * @param options - `allowFailure` returns the result instead of throwing;
 *   `env` adds entries over `HERMETIC_GIT_ENV`.
 * @returns `{ status, stdout, stderr }`.
 */
export function runGit(args, cwd, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...HERMETIC_GIT_ENV, ...(options.env ?? {}) },
  })
  if (result.error !== undefined && result.error !== null) throw result.error
  const outcome = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  if (outcome.status !== 0 && options.allowFailure !== true) {
    throw new Error(`git ${args.join(' ')} failed (${outcome.status}) in ${cwd}\n${outcome.stderr}`)
  }
  return outcome
}

/** @param value - absolute path. @returns the forward-slash form git accepts everywhere. */
function gitUrl(value) {
  return value.split(path.sep).join('/')
}

/**
 * Build a throwaway git fixture: a work repository with `main` (one commit) and
 * `develop` (one further commit), plus a bare clone of it that acts as the
 * "remote" every spec clones from.
 * @param options - `prefix` names the temp root.
 * @returns the fixture handle; call `cleanup()` (or pass it to `t.after`).
 */
export function makeRemote(options = {}) {
  const root = tempDir(options.prefix ?? 'dsh-wm-remote-')
  const work = path.join(root, 'source')
  const bare = path.join(root, 'remote.git')
  const email = 'workspace-manager-tests@example.invalid'
  const name = 'Workspace Manager Tests'

  fs.mkdirSync(work, { recursive: true })
  const git = (args, cwd = work) => runGit(args, cwd)
  git(['init', '-b', 'main'])
  git(['config', 'user.email', email])
  git(['config', 'user.name', name])
  fs.writeFileSync(path.join(work, 'README.md'), '# fixture\n')
  git(['add', '.'])
  git(['commit', '-m', 'initial commit'])
  const mainCommit = git(['rev-parse', 'main']).stdout.trim()

  git(['checkout', '-b', 'develop'])
  fs.writeFileSync(path.join(work, 'develop.txt'), 'develop\n')
  git(['add', '.'])
  git(['commit', '-m', 'develop commit'])
  const developCommit = git(['rev-parse', 'develop']).stdout.trim()
  git(['checkout', 'main'])

  git(['clone', '--bare', work, bare], root)
  git(['remote', 'add', 'origin', bare])

  return {
    root,
    work,
    bare,
    /** Clone URL (forward-slash path; git accepts it on every platform). */
    url: gitUrl(bare),
    branches: ['develop', 'main'],
    defaultBranch: 'main',
    commits: { main: mainCommit, develop: developCommit },
    /** @param args - git args. @param cwd - directory. @returns the run result. */
    git,
    /**
     * Commit one file onto a branch of the work repository and push it to the
     * bare remote, so a later clone/fetch sees it.
     * @param branch - branch to commit on.
     * @param file - file name to write.
     * @param message - commit message.
     * @returns the new commit id.
     */
    commitOn(branch, file, message) {
      git(['checkout', branch])
      fs.writeFileSync(path.join(work, file), `${message}\n`)
      git(['add', '.'])
      git(['commit', '-m', message])
      const commit = git(['rev-parse', 'HEAD']).stdout.trim()
      git(['push', 'origin', branch])
      git(['checkout', 'main'])
      return commit
    },
    /** @param cwd - a clone of this remote. @param args - git args. @returns the run result. */
    inClone(cwd, args) {
      return git(args, cwd)
    },
    cleanup() {
      removeDir(root)
    },
  }
}

/** @param location - a directory. @returns the branch checked out there. */
export function currentBranch(location) {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], location).stdout.trim()
}

/** @param location - a directory. @returns the commit ids in `git log`, newest first. */
export function logCommits(location) {
  return runGit(['log', '--format=%H'], location).stdout.trim().split('\n').filter(Boolean)
}

/**
 * A `workspaceRegistry` double: a real in-memory table plus a call ledger.
 * @param records - the ledger to append to.
 * @returns the registry double.
 */
export function makeFakeWorkspaceRegistry(records = { calls: [] }) {
  const items = new Map()
  let sequence = 0
  return {
    items,
    calls: records.calls,
    /**
     * @param workspacePath - absolute directory to register.
     * @param title - workspace title.
     * @returns the created workspace record.
     */
    async create(workspacePath, title) {
      records.calls.push({ op: 'create', args: [workspacePath, title] })
      const workspace = { id: `ws-${++sequence}`, path: workspacePath, title, sessionIds: [] }
      items.set(workspace.id, workspace)
      return workspace
    },
    /**
     * @param id - workspace id to remove.
     * @returns whether a record was removed.
     */
    async delete(id) {
      records.calls.push({ op: 'delete', args: [id] })
      return items.delete(id)
    },
    /** @param id - workspace id. @returns the record or undefined. */
    get(id) {
      records.calls.push({ op: 'get', args: [id] })
      return items.get(id)
    },
    /** @returns every registered workspace. */
    list() {
      records.calls.push({ op: 'list', args: [] })
      return [...items.values()]
    },
  }
}

/**
 * One `req` the plugin route handler can consume: an async iterable of body
 * chunks with `method`/`url`/`headers`.
 * @param options - request fields; `body` may be a string or a JSON value.
 * @returns the request double.
 */
export function makeFakeRequest(options = {}) {
  const body = options.body === undefined
    ? ''
    : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  const chunks = body.length === 0 ? [] : [Buffer.from(body, 'utf8')]
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/',
    headers: options.headers ?? { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** @returns a `res` double recording status, headers, and body. */
export function makeFakeResponse() {
  const chunks = []
  return {
    statusCode: null,
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
      }
      this.ended = true
      return this
    },
    get body() {
      return Buffer.concat(chunks).toString('utf8')
    },
    /** @returns the parsed body, or undefined when it is not JSON. */
    json() {
      try {
        return JSON.parse(this.body)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * A fake Host context. It carries both faces the core factory might consume —
 * the cordis context members (`get`, `effect`, `webServer`, `connection`, …)
 * and direct option/getter aliases (`getStorage`, `getSubprocess`, …) — so the
 * suite can drive `createWorkspaceManagerCore` without cordis.
 * @param options - capability overrides and `config`.
 * @returns the harness; `harness.ctx` is the same object.
 */
export function makeFakeCtx(options = {}) {
  const records = { routes: [], admits: [], effects: [], listeners: [], logs: [], registryCalls: [], provides: [] }
  const config = { ...(options.config ?? {}) }
  const logs = records.logs
  const logger = options.logger ?? {
    debug: (message) => logs.push({ level: 'debug', message: String(message) }),
    info: (message) => logs.push({ level: 'info', message: String(message) }),
    warn: (message) => logs.push({ level: 'warn', message: String(message) }),
    error: (message) => logs.push({ level: 'error', message: String(message) }),
  }
  const workspaceRegistry = options.workspaceRegistry ?? makeFakeWorkspaceRegistry({ calls: records.registryCalls })
  const subprocess = options.subprocess ?? null
  const storage = options.storage ?? null
  const connection = options.connection ?? {
    /** @param req - the incoming request. @returns `{ rejection }` when refused, `{ ok: true }` when admitted. */
    admit(req) {
      records.admits.push(req)
      if (typeof options.admit === 'function') return options.admit(req)
      if (options.admitted === false) return { rejection: 401 }
      return { ok: true }
    },
  }
  const webServer = options.webServer ?? {
    /** @param entry - the route registration. @returns its disposer. */
    register(entry) {
      records.routes.push(entry)
      return () => {
        const index = records.routes.indexOf(entry)
        if (index >= 0) records.routes.splice(index, 1)
      }
    },
  }
  const services = {
    webServer,
    connection,
    workspaceRegistry,
    logger,
    subprocess: subprocess ?? undefined,
    ...(storage === null ? {} : { storage }),
    ...(options.services ?? {}),
  }

  const harness = {
    records,
    config,
    logger,
    subprocess,
    storage,
    connection,
    webServer,
    workspaceRegistry,
    services,
    /** @param name - service name. @returns the service or undefined. */
    get(name) {
      return services[name]
    },
    /** @param name - service name. @returns whether the service is composed. */
    has(name) {
      return services[name] !== undefined && services[name] !== null
    },
    /**
     * Register a service, as `ctx.provide` does.
     * @param name - service name.
     * @param value - service value.
     * @returns its disposer.
     */
    provide(name, value) {
      const previous = services[name]
      services[name] = value
      records.provides.push({ name, value })
      return () => {
        if (services[name] === value) services[name] = previous
      }
    },
    /** @param fn - effect body. @returns its disposer. */
    effect(fn) {
      records.effects.push(fn)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    /** @param name - event name. @param listener - listener. @returns its disposer. */
    on(name, listener) {
      records.listeners.push({ name, listener })
      return () => {}
    },
    getStorage: () => storage,
    getSubprocess: () => subprocess,
    getWorkspaceRegistry: () => workspaceRegistry,
    getWebServer: () => webServer,
    getConnection: () => connection,
    getLogger: () => logger,
    getConfig: () => config,
  }
  harness.ctx = harness
  return harness
}

/**
 * Feed one request into the prefix route the Host registered on the fake
 * web server.
 * @param harness - a `makeFakeCtx` harness.
 * @param options - `method`, `url`, `body`, `headers`.
 * @returns the response double, plus the matched route.
 * @throws when no registered route claims the URL.
 */
export async function requestRoute(harness, options = {}) {
  const routes = harness.records.routes
  if (routes.length === 0) throw new Error('no webServer route was registered')
  const url = options.url ?? '/'
  const route = routes.find((entry) => entry.kind === 'prefix' && url.startsWith(entry.path))
    ?? routes.find((entry) => url.startsWith(entry.path))
  if (route === undefined) throw new Error(`no registered route matches ${url}`)
  const req = makeFakeRequest({ ...options, url })
  const res = makeFakeResponse()
  await route.handler(req, res)
  return { res, route }
}
