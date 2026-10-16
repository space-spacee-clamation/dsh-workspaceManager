/**
 * dsh-workspace-manager — Host half.
 *
 * Owns the whole Host domain: the repo presets, the durable JSON store, the
 * git engine (clone → fetch → branch), the background job runner, and the DSH
 * workspace registration. `createWorkspaceManagerCore()` returns that domain
 * as a plain object, so the entire Host half is driven by fakes with no cordis
 * around it; `apply()` only wires that core to the framework — one provided
 * service, one `/workspace-manager` prefix route, one lifecycle effect.
 *
 * `subprocess` and `workspaceRegistry` are read through `ctx.get` on every use,
 * so a profile that composes neither still loads the plugin, serves the panel,
 * and answers the documented capability-absent codes.
 *
 * @module dsh-workspace-manager
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, normalize as normalizePath } from 'node:path'

import { CODES, fail, message, toWireError } from './host/errors.js'
import { createGitRunner } from './host/git.js'
import { newId, nowIso } from './host/ids.js'
import { createJobRunner } from './host/manager.js'
import {
  applyTemplate, defaultWorkspacesDir, isEmptyDirectory, isDirectorySync, joinDirectory,
  pathExistsSync, storageFileFor,
} from './host/paths.js'
import { createStore } from './host/store.js'
import {
  CONTROL_PATTERN, DEFAULT_SETTINGS, absoluteDir, asObject, booleanOf, boundedText, branchName,
  checkDirectoryName, checkName, comparablePath, deriveBranch, docId, normalizeSettings,
  optionalText, requireText, slug,
} from './host/validate.js'

/** Cordis plugin name; also the service key provided to other plugins. */
export const name = 'workspaceManager'

/**
 * `connection` supplies the trusted-request admission check and `webServer`
 * the route the browser half talks to. `subprocess` and `workspaceRegistry`
 * are optional and resolved through `ctx.get`, so a Host that composes
 * neither still mounts this plugin.
 */
export const inject = ['connection', 'webServer']

/** Absolute RPC channel registered on the shared Web server. */
export const CHANNEL = '/workspace-manager'

/** Largest request body accepted on the plugin route, in bytes. */
export const MAX_REQUEST_BYTES = 1_000_000

/** How many items `state`/`observe` inspect concurrently. */
export const OBSERVE_CONCURRENCY = 4

/** How long `fs/reveal` waits for a launcher before calling the reveal done. */
export const REVEAL_WATCH_MS = 1_500

/** Per-stream cap for the file-manager launcher, whose output nobody reads. */
export const REVEAL_OUTPUT_BYTES = 8_192

/**
 * Loader-row defaults, matching the keys documented in `cordis.patch.yml`.
 * The nine `Settings` keys double as the initial settings of a fresh store;
 * `storageFile` is config-only.
 */
export const DEFAULT_CONFIG = Object.freeze({ ...DEFAULT_SETTINGS, storageFile: '' })

/**
 * Validate and normalize one loader row. Fails loud (a `TypeError` naming the
 * field) instead of carrying an unusable value into a git command.
 * @param raw - the raw row config, possibly absent or partial.
 * @param base - defaults the row is layered onto.
 * @returns {Readonly<typeof DEFAULT_CONFIG>} the complete configuration.
 * @throws {TypeError} when a present field has the wrong type or shape.
 */
export function normalizeConfig(raw, base = DEFAULT_CONFIG) {
  const source = asObject(raw)
  const config = { ...base }
  /**
   * Read one string field.
   * @param key - config key.
   * @returns {string} the trimmed value, or the default.
   */
  const text = (key) => {
    if (source[key] === undefined || source[key] === null) return config[key]
    if (typeof source[key] !== 'string') throw new TypeError(`workspaceManager: 配置项 ${key} 必须是字符串`)
    return source[key].trim()
  }
  /**
   * Read one boolean field.
   * @param key - config key.
   * @returns {boolean} the flag, or the default.
   */
  const flag = (key) => {
    if (source[key] === undefined || source[key] === null) return config[key]
    if (typeof source[key] !== 'boolean') throw new TypeError(`workspaceManager: 配置项 ${key} 必须是布尔值`)
    return source[key]
  }
  /**
   * Read one integer field.
   * @param key - config key.
   * @param min - inclusive lower bound.
   * @param max - inclusive upper bound.
   * @returns {number} the value, or the default.
   */
  const count = (key, min, max) => {
    if (source[key] === undefined || source[key] === null) return config[key]
    const value = source[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(`workspaceManager: 配置项 ${key} 必须是整数`)
    }
    if (value < min || value > max) {
      throw new TypeError(`workspaceManager: 配置项 ${key} 必须在 ${min}..${max} 之间`)
    }
    return value
  }

  config.defaultParentDir = text('defaultParentDir')
  config.directoryTemplate = text('directoryTemplate')
  config.branchPrefix = text('branchPrefix')
  config.cloneDepth = count('cloneDepth', 0, 1000)
  config.partialClone = flag('partialClone')
  config.fetchBeforeCreate = flag('fetchBeforeCreate')
  config.deleteDirectoryOnArchive = flag('deleteDirectoryOnArchive')
  config.autoOpenSession = flag('autoOpenSession')
  config.concurrency = count('concurrency', 1, 16)
  config.storageFile = text('storageFile')

  if (config.defaultParentDir.length > 0 && !isAbsolute(config.defaultParentDir)) {
    throw new TypeError('workspaceManager: 配置项 defaultParentDir 必须是绝对路径')
  }
  if (config.storageFile.length > 0 && !isAbsolute(config.storageFile)) {
    throw new TypeError('workspaceManager: 配置项 storageFile 必须是绝对路径')
  }
  if (config.directoryTemplate.length === 0) {
    throw new TypeError('workspaceManager: 配置项 directoryTemplate 不能为空')
  }
  return Object.freeze(config)
}

/**
 * Standard-schema form of {@link normalizeConfig}, so the Loader validates and
 * normalizes the row before `apply` runs and reports a bad row at mount time
 * instead of at the first request.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-workspace-manager',
    /**
     * @param value - the raw row config.
     * @returns {{value: object} | {issues: object[]}} the normalized config, or the failure.
     */
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: message(error) }] }
      }
    },
  }),
})

/**
 * Build the Host domain. The returned object is the frozen test seam of
 * `docs/PROTOCOL.md` and has exactly four members; the fourteen RPC methods
 * are reached through `dispatch`.
 *
 * @param {object} [options] - the seam options.
 * @param {() => object | undefined} [options.getSubprocess] - `ctx.get('subprocess')` indirection.
 * @param {() => object | undefined} [options.getWorkspaceRegistry] - `ctx.get('workspaceRegistry')` indirection.
 * @param {{warn?: Function, info?: Function, error?: Function, debug?: Function}} [options.logger] - optional logger.
 * @param {object} [options.config] - the normalized config (see `cordis.patch.yml`).
 * @param {object} [options.store] - override the JSON store; when omitted one is created from `config.storageFile`.
 * @returns {{
 *   dispatch: (method: string, payload?: object) => Promise<object>,
 *   start: () => Promise<void>,
 *   close: () => Promise<void>,
 *   onChange: (listener: (change: object) => void) => () => void,
 * }} the core.
 */
export function createWorkspaceManagerCore(options = {}) {
  const getSubprocess = typeof options.getSubprocess === 'function' ? options.getSubprocess : () => undefined
  const getWorkspaceRegistry = typeof options.getWorkspaceRegistry === 'function'
    ? options.getWorkspaceRegistry
    : () => undefined
  const logger = options.logger
  const config = normalizeConfig(options.config ?? {})
  const store = options.store ?? createStore({
    file: storageFileFor({ override: config.storageFile }),
    logger,
  })

  const git = createGitRunner({ getSubprocess, logger })
  const listeners = new Set()
  let startPromise = null
  let closed = false

  /** @returns {object} the store handle. */
  function storeOf() {
    return store
  }

  /** @returns {string} the JSON store path, for `state.stores`. */
  function storeFile() {
    const declared = storeOf().file
    if (typeof declared === 'string' && declared.length > 0) return declared
    return storageFileFor({ override: config.storageFile })
  }

  /** @returns {string | null} the store's last write failure. */
  function storeWriteError() {
    const value = storeOf().writeError
    return typeof value === 'string' && value.length > 0 ? value : null
  }

  /**
   * Publish a change to every listener. The payload is the cheap stored view:
   * observations are not run, so a listener never triggers git work.
   */
  function notify() {
    if (listeners.size === 0) return
    const document = storeOf().read()
    const change = {
      repos: document.repos,
      items: document.items,
      jobs: runner.list(),
      settings: document.settings,
    }
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        logger?.warn?.(`workspace-manager: 变化通知失败：${message(error)}`)
      }
    }
  }

  /**
   * Persist a mutated document and publish the change.
   * @param mutate - receives the current document, returns the next one.
   * @returns {object} the committed document.
   * @throws {import('./host/errors.js').WorkspaceManagerError} `storage-failed`.
   */
  function commit(mutate) {
    const current = storeOf().read()
    const next = mutate(current) ?? current
    if (storeOf().write(next) === false) {
      throw fail(CODES.storageFailed, `写入存储失败：${storeWriteError() ?? '未知原因'}`, { file: storeFile() })
    }
    notify()
    return storeOf().read()
  }

  const runner = createJobRunner({
    concurrency: () => settingsOf().concurrency,
    logger,
    onSettle: () => notify(),
  })

  /** @returns {object | undefined} the composed workspace registry, when there is one. */
  function registryOf() {
    const registry = getWorkspaceRegistry()
    return registry === undefined || registry === null ? undefined : registry
  }

  /**
   * @returns {object} the registry, or throws the documented code.
   * @throws {import('./host/errors.js').WorkspaceManagerError} `registry-unavailable`.
   */
  function requireRegistry() {
    const registry = registryOf()
    if (registry === undefined || typeof registry.create !== 'function') {
      throw fail(CODES.registryUnavailable, '此 Host 没有提供 workspaceRegistry 能力，无法修改 DSH 工作区列表')
    }
    return registry
  }

  /**
   * @throws {import('./host/errors.js').WorkspaceManagerError} `no-git` when this Host composes no subprocess capability.
   */
  function requireGit() {
    const subprocess = getSubprocess()
    if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
      throw fail(CODES.noGit, '此 Host 没有提供 subprocess 能力，无法运行 git')
    }
  }

  /**
   * @returns {object} the current settings.
   */
  function settingsOf() {
    return storeOf().read().settings
  }

  /**
   * The settings a fresh store starts from: the loader row's values.
   * @returns {object} the settings-shaped subset of the config.
   */
  function settingsFromConfig() {
    return {
      defaultParentDir: config.defaultParentDir,
      directoryTemplate: config.directoryTemplate,
      branchPrefix: config.branchPrefix,
      cloneDepth: config.cloneDepth,
      partialClone: config.partialClone,
      fetchBeforeCreate: config.fetchBeforeCreate,
      deleteDirectoryOnArchive: config.deleteDirectoryOnArchive,
      autoOpenSession: config.autoOpenSession,
      concurrency: config.concurrency,
    }
  }

  /** Load the store from disk and seed a fresh one from the loader row. Idempotent. */
  async function initialize() {
    if (typeof storeOf().reload === 'function') storeOf().reload()
    const document = storeOf().read()
    if (storeOf().fresh !== true) return
    storeOf().write({ ...document, settings: { ...document.settings, ...settingsFromConfig() } })
  }

  /**
   * @returns {Promise<void>} resolves once the store is loaded. Idempotent.
   */
  function start() {
    if (startPromise === null) startPromise = Promise.resolve().then(initialize)
    return startPromise
  }

  /**
   * @param document - the current document.
   * @param id - the repo id.
   * @returns {object | undefined} the repo, when it exists.
   */
  function findRepo(document, id) {
    return document.repos.find((repo) => repo.id === id)
  }

  /**
   * @param document - the current document.
   * @param id - the workspace record id.
   * @returns {object | undefined} the item, when it exists.
   */
  function findItem(document, id) {
    return document.items.find((item) => item.id === id)
  }

  /**
   * Whether the DSH registration behind one record still exists. Without a
   * registry the record's own claim is reported, so the panel never shows a
   * false "unregistered" badge on a Host that cannot verify.
   * @param workspaceId - the recorded DSH workspace id.
   * @returns {Promise<boolean>} whether the registration is still there.
   */
  async function isRegistered(workspaceId) {
    if (workspaceId === null) return false
    const registry = registryOf()
    if (registry === undefined || typeof registry.get !== 'function') return true
    try {
      return registry.get(workspaceId) !== undefined
    } catch (error) {
      logger?.warn?.(`workspace-manager: 查询 DSH 工作区 ${workspaceId} 失败：${message(error)}`)
      return true
    }
  }

  /**
   * Observe one stored record: existence, registration, and (through git) the
   * current branch, dirtiness, and upstream distance.
   * @param item - the stored item.
   * @returns {Promise<object>} the `WorkspaceItem` with its observed `status`.
   */
  async function observeItem(item) {
    const exists = isDirectorySync(item.path)
    const registered = await isRegistered(item.workspaceId)
    const observed = exists
      ? await git.observe(item.path)
      : { branch: null, dirty: false, ahead: -1, behind: -1, error: null }
    return {
      ...item,
      status: {
        exists,
        registered,
        branch: typeof observed.branch === 'string' && observed.branch.length > 0 ? observed.branch : null,
        dirty: observed.dirty === true,
        ahead: Number.isInteger(observed.ahead) ? observed.ahead : -1,
        behind: Number.isInteger(observed.behind) ? observed.behind : -1,
        error: typeof observed.error === 'string' && observed.error.length > 0 ? observed.error : null,
      },
    }
  }

  /**
   * Observe several records with bounded concurrency.
   * @param items - stored items.
   * @returns {Promise<object[]>} the observed items, in input order.
   */
  async function observeAll(items) {
    const results = new Array(items.length)
    let cursor = 0
    const workers = []
    const width = Math.max(1, Math.min(OBSERVE_CONCURRENCY, items.length))
    for (let index = 0; index < width; index += 1) {
      workers.push((async () => {
        for (;;) {
          const current = cursor
          cursor += 1
          if (current >= items.length) return
          results[current] = await observeItem(items[current])
        }
      })())
    }
    await Promise.all(workers)
    return results
  }

  /**
   * Refuse a target directory that is already taken by a non-empty directory
   * or a file.
   * @param target - absolute target directory.
   * @throws {import('./host/errors.js').WorkspaceManagerError} `path-exists`.
   */
  function assertTargetFree(target) {
    if (!pathExistsSync(target)) return
    if (!isDirectorySync(target)) {
      throw fail(CODES.pathExists, `目标路径已存在同名文件：${target}`, { path: target })
    }
    if (!isEmptyDirectory(target)) {
      throw fail(CODES.pathExists, `目标目录已存在且非空：${target}`, { path: target })
    }
  }

  /**
   * Validate a base branch loosely: it is passed to git, which reports a bad
   * ref far better than a name check could.
   * @param value - the trimmed base branch.
   * @param field - field name used in the diagnostic.
   * @returns {string} the base branch, or `''`.
   * @throws {import('./host/errors.js').WorkspaceManagerError} `bad-request`.
   */
  function checkLooseRef(value, field) {
    if (value.length === 0) return ''
    if (CONTROL_PATTERN.test(value)) throw fail(CODES.badRequest, `${field} 不能包含控制字符`)
    if (value.startsWith('-')) throw fail(CODES.badRequest, `${field} 不能以 "-" 开头`)
    return value
  }

  /**
   * Remove one record's DSH registration inside a job.
   * @param item - the stored item.
   * @param context - the job context (step and log).
   * @returns {Promise<void>} resolution after the registry answered.
   * @throws {import('./host/errors.js').WorkspaceManagerError} `registry-failed`.
   */
  async function releaseRegistration(item, context) {
    if (item.workspaceId === null) {
      context.log('info', '记录中没有 DSH 工作区 id，跳过移除')
      return
    }
    const registry = registryOf()
    if (registry === undefined || typeof registry.delete !== 'function') {
      context.log('warn', '此 Host 没有 workspaceRegistry，DSH 工作区列表保持不变')
      return
    }
    context.step('正在从 DSH 工作区列表移除', 0.3)
    try {
      const removed = await registry.delete(item.workspaceId)
      if (removed === false) context.log('warn', `DSH 工作区列表中已无 ${item.workspaceId}`)
      else context.log('info', `已移除 DSH 工作区 ${item.workspaceId}`)
    } catch (error) {
      throw fail(CODES.registryFailed, `从 DSH 工作区列表移除失败：${message(error)}`, {
        workspaceId: item.workspaceId,
      })
    }
  }

  /**
   * Delete one clone directory as part of an explicitly destructive job.
   * @param dir - the absolute directory.
   * @param context - the job context (step and log).
   * @throws {import('./host/errors.js').WorkspaceManagerError} `storage-failed` when the filesystem refused.
   */
  function removeDirectory(dir, context) {
    if (!pathExistsSync(dir)) {
      context.log('info', '目录已不存在，无需删除')
      return
    }
    context.step('正在删除目录', 0.8)
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      context.log('warn', `已删除目录 ${dir}`)
    } catch (error) {
      throw fail(CODES.storageFailed, `删除目录失败：${message(error)}`, { path: dir })
    }
  }

  /**
   * Resolve the platform's file-manager launcher.
   * @param subprocess - the subprocess service.
   * @returns {Promise<string | null>} the executable path, or `null`.
   */
  async function revealExecutable(subprocess) {
    const candidates = process.platform === 'win32'
      ? ['explorer.exe', 'explorer']
      : process.platform === 'darwin' ? ['open'] : ['xdg-open']
    for (const candidate of candidates) {
      try {
        const resolved = await subprocess.resolveExecutable(candidate)
        if (typeof resolved === 'string' && resolved.length > 0) return resolved
      } catch (error) {
        // Try the next candidate: a Host may ship only one of the two Windows spellings.
        void error
      }
    }
    return null
  }

  /**
   * Race a promise against a delay, clearing the timer either way.
   * @param promise - the promise to watch.
   * @param ms - the watch window.
   * @returns {Promise<unknown | 'pending'>} the settled value, or `'pending'`.
   */
  async function raceWithDelay(promise, ms) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('pending'), ms)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------------
  // RPC methods. Each one is `payload` in, documented `value` out.
  // ---------------------------------------------------------------------

  /**
   * `state`: the whole panel state.
   * @returns {Promise<object>} `{ repos, items, jobs, settings, stores }`.
   */
  async function stateEndpoint() {
    const document = storeOf().read()
    const items = await observeAll(document.items)
    const info = await git.info()
    return {
      repos: document.repos,
      items,
      jobs: runner.list(),
      settings: settingsOf(),
      stores: {
        file: storeFile(),
        writeError: storeWriteError(),
        gitPath: info.path,
        gitVersion: info.version,
      },
    }
  }

  /**
   * `repos/branches`: list a remote's branches and default branch.
   * @param payload - `{ url }`.
   * @returns {Promise<{branches: string[], head: string | null}>} the remote facts.
   */
  async function reposBranches(payload) {
    const input = asObject(payload)
    const url = requireText(input.url, 2000, 'url')
    const result = await git.lsRemote(url, {})
    return { branches: result.branches, head: result.head }
  }

  /**
   * Derive a display name for an ad-hoc remote.
   * @param url - the remote URL or path.
   * @returns {string} the final path segment without a `.git` suffix.
   */
  function repoNameFromUrl(url) {
    const trimmed = url.replace(/[\\/]+$/, '')
    const last = trimmed.split(/[\\/]/).pop() ?? ''
    return last.replace(/\.git$/i, '') || 'repo'
  }

  /**
   * Mint a repo id that is unique inside the store.
   * @param document - the current document.
   * @param seed - the preferred slug.
   * @returns {string} a stored-id-shaped, unused id.
   */
  function uniqueRepoId(document, seed) {
    const base = docId(seed) || `repo-${Date.now().toString(36)}`
    let candidate = base
    let suffix = 2
    while (document.repos.some((repo) => repo.id === candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  /**
   * `repos/save`: upsert one repo preset.
   * @param payload - `{ repo: Partial<Repo> & { url } }` (a flat payload is accepted too).
   * @returns {Promise<{repo: object}>} the saved record.
   */
  async function reposSave(payload) {
    const outer = asObject(payload)
    const inner = asObject(outer.repo)
    const input = Object.keys(inner).length > 0 ? inner : outer
    const url = requireText(input.url, 2000, 'url')
    const name = optionalText(input.name, 200, 'name') || repoNameFromUrl(url)
    const requestedId = input.id === undefined || input.id === null ? '' : requireText(input.id, 100, 'id')
    if (requestedId.length > 0 && docId(requestedId).length === 0) {
      throw fail(CODES.badRequest, 'id 只能包含字母、数字、点、下划线和连字符')
    }
    const baseBranch = checkLooseRef(optionalText(input.baseBranch, 200, 'baseBranch'), 'baseBranch')
    const parentDirRaw = optionalText(input.parentDir, 1000, 'parentDir')
    const parentDir = parentDirRaw.length > 0 ? absoluteDir(parentDirRaw, 'parentDir') : ''
    const document = storeOf().read()
    const id = requestedId.length > 0 ? requestedId : uniqueRepoId(document, slug(name, 'repo'))
    const existing = findRepo(document, id)
    const stamp = nowIso()
    const repo = {
      id,
      name,
      url,
      baseBranch,
      parentDir,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    }
    commit((current) => ({
      ...current,
      repos: existing === undefined
        ? [...current.repos, repo]
        : current.repos.map((entry) => (entry.id === id ? repo : entry)),
    }))
    return { repo }
  }

  /**
   * `repos/remove`: forget one repo preset. Unknown ids are an idempotent miss.
   * @param payload - `{ id }`.
   * @returns {Promise<{removed: boolean}>} whether a record was removed.
   */
  async function reposRemove(payload) {
    const input = asObject(payload)
    const id = requireText(input.id, 100, 'id')
    const document = storeOf().read()
    if (findRepo(document, id) === undefined) return { removed: false }
    commit((current) => ({ ...current, repos: current.repos.filter((repo) => repo.id !== id) }))
    return { removed: true }
  }

  /**
   * `workspaces/create`: validate, then run the clone → branch → register →
   * persist flow as a background job.
   * @param payload - `CreateRequest`.
   * @returns {Promise<{job: object}>} the immediately-returned job.
   */
  async function workspacesCreate(payload) {
    const input = asObject(payload)
    const running = settingsOf()
    const document = storeOf().read()
    const name = checkName(input.name, 'name')
    const repoId = input.repoId === undefined || input.repoId === null
      ? ''
      : requireText(input.repoId, 100, 'repoId')
    const repo = repoId.length > 0 ? findRepo(document, repoId) : undefined
    if (repoId.length > 0 && repo === undefined) throw fail(CODES.notFound, `找不到仓库记录：${repoId}`)
    const url = repo !== undefined ? repo.url : requireText(input.url, 2000, 'url')
    const baseBranch = checkLooseRef(
      optionalText(input.baseBranch, 200, 'baseBranch') || repo?.baseBranch || '',
      'baseBranch',
    )
    const parentRaw = optionalText(input.parentDir, 1000, 'parentDir')
      || repo?.parentDir
      || running.defaultParentDir
      || ''
    const parentDir = parentRaw.length > 0 ? absoluteDir(parentRaw, 'parentDir') : defaultWorkspacesDir()
    const typedBranch = optionalText(input.branch, 200, 'branch')
    const branch = typedBranch.length > 0
      ? branchName(typedBranch, 'branch')
      : deriveBranch(running.branchPrefix, name)
    const title = optionalText(input.title, 200, 'title') || name
    const typedDirectory = optionalText(input.directoryName, 120, 'directoryName')
    const directoryName = typedDirectory.length > 0
      ? checkDirectoryName(typedDirectory, 'directoryName')
      : checkDirectoryName(
        applyTemplate(running.directoryTemplate, { repo: repo?.name ?? repoNameFromUrl(url), name, branch }),
        '目录名',
      )
    const target = joinDirectory(parentDir, directoryName)
    assertTargetFree(target)
    requireGit()
    requireRegistry()

    const depth = running.cloneDepth
    const partial = running.partialClone
    const fetchFirst = booleanOf(input.fetch, 'fetch', running.fetchBeforeCreate)
    const itemId = newId('ws')

    const job = runner.start({
      kind: 'create',
      label: branch,
      task: async (context) => {
        context.log('info', `目标目录 ${target}`)
        try {
          assertTargetFree(target)
          context.step('正在克隆仓库', -1)
          mkdirSync(parentDir, { recursive: true })
          await git.clone(url, target, {
            depth,
            partial,
            base: baseBranch,
            signal: context.signal,
            onLine: (line) => context.log('info', line),
          })
          context.log('info', '克隆完成')
          context.step('正在创建分支', 0.7)
          await git.createBranch(target, branch, baseBranch, {
            fetch: fetchFirst,
            signal: context.signal,
            onLine: (line) => context.log('info', line),
          })
          context.log('info', `已切换到分支 ${branch}`)
          context.step('正在登记 DSH 工作区', 0.85)
          const registry = requireRegistry()
          const workspace = await registry.create(target, title)
          const workspaceId = workspace === undefined || workspace === null ? '' : String(workspace.id ?? '')
          if (workspaceId.length === 0) {
            throw fail(CODES.registryFailed, 'workspaceRegistry.create 没有返回工作区 id', { path: target })
          }
          context.log('info', `已登记 DSH 工作区 ${workspaceId}`)
          context.step('正在保存记录', 0.95)
          const stamp = nowIso()
          const item = {
            id: itemId,
            workspaceId,
            name,
            title,
            path: target,
            repoId: repo?.id ?? null,
            repoName: repo?.name ?? repoNameFromUrl(url),
            repoUrl: url,
            baseBranch,
            branch,
            archived: false,
            createdAt: stamp,
            updatedAt: stamp,
            archivedAt: null,
          }
          commit((current) => ({ ...current, items: [...current.items, item] }))
          context.step('完成', 1)
          return itemId
        } catch (error) {
          if (pathExistsSync(target)) {
            context.log('warn', `未完成的部分已保留在磁盘上：${target}（未自动删除）`)
          }
          throw error
        }
      },
    })
    notify()
    return { job }
  }

  /**
   * The explicit `deleteDirectory` intent, falling back to the persisted
   * setting only when the request did not state one.
   * @param input - the request payload.
   * @returns {boolean} whether the directory should be removed.
   */
  function wantsDirectoryRemoval(input) {
    if (input.deleteDirectory === undefined) return settingsOf().deleteDirectoryOnArchive === true
    return booleanOf(input.deleteDirectory, 'deleteDirectory', false)
  }

  /**
   * `workspaces/archive`: unregister, mark archived, and optionally delete.
   * @param payload - `{ id, deleteDirectory? }`.
   * @returns {Promise<{job: object}>} the immediately-returned job.
   */
  async function workspacesArchive(payload) {
    const input = asObject(payload)
    const id = requireText(input.id, 100, 'id')
    const document = storeOf().read()
    const item = findItem(document, id)
    if (item === undefined) throw fail(CODES.notFound, `找不到工作区记录：${id}`)
    const remove = wantsDirectoryRemoval(input)
    const job = runner.start({
      kind: 'archive',
      label: item.name || item.branch || item.id,
      task: async (context) => {
        await releaseRegistration(item, context)
        context.step('正在更新记录', 0.6)
        const stamp = nowIso()
        commit((current) => ({
          ...current,
          items: current.items.map((entry) => (entry.id === item.id
            ? { ...entry, archived: true, workspaceId: null, archivedAt: stamp, updatedAt: stamp }
            : entry)),
        }))
        context.log('info', '已标记为归档')
        if (remove) removeDirectory(item.path, context)
        context.step('完成', 1)
        return null
      },
    })
    notify()
    return { job }
  }

  /**
   * `workspaces/forget`: unregister, optionally delete the directory, and drop
   * the record entirely.
   * @param payload - `{ id, deleteDirectory? }`.
   * @returns {Promise<{job: object}>} the immediately-returned job. The `Job`
   * union has no `forget` arm, so this job reports `kind: 'archive'`.
   */
  async function workspacesForget(payload) {
    const input = asObject(payload)
    const id = requireText(input.id, 100, 'id')
    const document = storeOf().read()
    const item = findItem(document, id)
    if (item === undefined) throw fail(CODES.notFound, `找不到工作区记录：${id}`)
    const remove = wantsDirectoryRemoval(input)
    const job = runner.start({
      kind: 'archive',
      label: item.name || item.branch || item.id,
      task: async (context) => {
        await releaseRegistration(item, context)
        if (remove) removeDirectory(item.path, context)
        context.step('正在删除记录', 0.9)
        commit((current) => ({
          ...current,
          items: current.items.filter((entry) => entry.id !== item.id),
        }))
        context.log('info', '记录已从工作区管理器删除')
        context.step('完成', 1)
        return null
      },
    })
    notify()
    return { job }
  }

  /**
   * `workspaces/restore`: re-register an archived record into the DSH workspace list.
   * @param payload - `{ id }`.
   * @returns {Promise<{item: object}>} the restored record with a fresh observation.
   */
  async function workspacesRestore(payload) {
    const input = asObject(payload)
    const id = requireText(input.id, 100, 'id')
    const document = storeOf().read()
    const item = findItem(document, id)
    if (item === undefined) throw fail(CODES.notFound, `找不到工作区记录：${id}`)
    if (!isDirectorySync(item.path)) {
      throw fail(CODES.badRequest, `目录不存在，无法恢复：${item.path}`, { path: item.path })
    }
    const registry = requireRegistry()
    let workspaceId = item.workspaceId
    let known = false
    if (workspaceId !== null && typeof registry.get === 'function') {
      try {
        known = registry.get(workspaceId) !== undefined
      } catch (error) {
        logger?.warn?.(`workspace-manager: 查询 DSH 工作区 ${workspaceId} 失败：${message(error)}`)
        known = false
      }
    }
    if (!known) {
      let created
      try {
        created = await registry.create(item.path, item.title || item.name)
      } catch (error) {
        throw fail(CODES.registryFailed, `重新登记 DSH 工作区失败：${message(error)}`, { path: item.path })
      }
      workspaceId = created === undefined || created === null ? '' : String(created.id ?? '')
      if (workspaceId.length === 0) {
        throw fail(CODES.registryFailed, 'workspaceRegistry.create 没有返回工作区 id', { path: item.path })
      }
    }
    const stamp = nowIso()
    const next = { ...item, workspaceId, archived: false, archivedAt: null, updatedAt: stamp }
    commit((current) => ({
      ...current,
      items: current.items.map((entry) => (entry.id === item.id ? next : entry)),
    }))
    return { item: await observeItem(next) }
  }

  /**
   * `workspaces/rename`: rename our record. The DSH title is kept in step by
   * the browser half through `workspaces.rename(workspaceId, title)`.
   * @param payload - `{ id, name?, title? }`.
   * @returns {Promise<{item: object}>} the renamed record with a fresh observation.
   */
  async function workspacesRename(payload) {
    const input = asObject(payload)
    const id = requireText(input.id, 100, 'id')
    if (input.name === undefined && input.title === undefined) {
      throw fail(CODES.badRequest, 'name 和 title 至少要提供一个')
    }
    const document = storeOf().read()
    const item = findItem(document, id)
    if (item === undefined) throw fail(CODES.notFound, `找不到工作区记录：${id}`)
    const nextName = input.name === undefined ? item.name : checkName(input.name, 'name')
    const nextTitle = input.title === undefined
      ? item.title
      : (optionalText(input.title, 200, 'title') || nextName)
    const next = { ...item, name: nextName, title: nextTitle, updatedAt: nowIso() }
    commit((current) => ({
      ...current,
      items: current.items.map((entry) => (entry.id === item.id ? next : entry)),
    }))
    return { item: await observeItem(next) }
  }

  /**
   * `workspaces/observe`: observe one record, the records at one path, or all.
   * @param payload - `{ id?, path? }`.
   * @returns {Promise<{items: object[]}>} the observed records.
   */
  async function workspacesObserve(payload) {
    const input = asObject(payload)
    const document = storeOf().read()
    const id = optionalText(input.id, 100, 'id')
    const path = optionalText(input.path, 1000, 'path')
    let targets = document.items
    if (id.length > 0) {
      const item = findItem(document, id)
      if (item === undefined) throw fail(CODES.notFound, `找不到工作区记录：${id}`)
      targets = [item]
    } else if (path.length > 0) {
      const wanted = comparablePath(path)
      targets = document.items.filter((item) => comparablePath(item.path) === wanted)
    }
    return { items: await observeAll(targets) }
  }

  /**
   * `jobs/list`: every retained job, newest first.
   * @returns {Promise<{jobs: object[]}>} the jobs.
   */
  async function jobsList() {
    return { jobs: runner.list() }
  }

  /**
   * `jobs/cancel`: cancel a queued or running job.
   * @param payload - `{ id }`.
   * @returns {Promise<{cancelled: boolean}>} whether the job was still running.
   */
  async function jobsCancel(payload) {
    const input = asObject(payload)
    const id = requireText(input.id, 100, 'id')
    return { cancelled: runner.cancel(id) }
  }

  /**
   * `settings/set`: apply a validated settings patch.
   * @param payload - `{ patch }`.
   * @returns {Promise<{settings: object}>} the complete settings.
   */
  async function settingsSet(payload) {
    const input = asObject(payload)
    const patch = asObject(input.patch)
    const current = settingsOf()
    if (Object.keys(patch).length === 0) return { settings: current }
    const settings = normalizeSettings(patch, current, { strict: true })
    commit((document) => ({ ...document, settings }))
    runner.pump()
    return { settings }
  }

  /**
   * `fs/reveal`: show a directory in the OS file manager. Never throws for a
   * failed launch; the panel only needs to know whether it worked.
   * @param payload - `{ path }`.
   * @returns {Promise<{revealed: boolean}>} whether a launcher was started.
   */
  async function fsReveal(payload) {
    const input = asObject(payload)
    const requested = requireText(input.path, 1000, 'path')
    const target = isAbsolute(requested) ? normalizePath(requested) : requested
    try {
      if (!pathExistsSync(target)) return { revealed: false }
      const subprocess = getSubprocess()
      if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
        return { revealed: false }
      }
      const executable = await revealExecutable(subprocess)
      if (executable === null) return { revealed: false }
      const handle = subprocess.spawn({
        argv: [executable, target],
        cwd: dirname(target),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: REVEAL_OUTPUT_BYTES },
          stderr: { maxBytes: REVEAL_OUTPUT_BYTES },
        },
        graceMs: 1_000,
      })
      const outcome = await raceWithDelay(
        Promise.resolve(handle?.done).then((value) => value, () => null),
        REVEAL_WATCH_MS,
      )
      // A launcher still running when the window closes counts as launched;
      // Windows' explorer.exe also reports exit code 1 on success.
      if (outcome === 'pending') return { revealed: true }
      if (process.platform === 'win32') return { revealed: true }
      return { revealed: outcome !== null && asObject(outcome).exitCode === 0 }
    } catch (error) {
      logger?.warn?.(`workspace-manager: 打开文件管理器失败：${message(error)}`)
      return { revealed: false }
    }
  }

  /** Every RPC method, keyed by its PROTOCOL.md method string. */
  const endpoints = Object.freeze({
    'state': () => stateEndpoint(),
    'repos/branches': (payload) => reposBranches(payload),
    'repos/save': (payload) => reposSave(payload),
    'repos/remove': (payload) => reposRemove(payload),
    'workspaces/create': (payload) => workspacesCreate(payload),
    'workspaces/archive': (payload) => workspacesArchive(payload),
    'workspaces/restore': (payload) => workspacesRestore(payload),
    'workspaces/rename': (payload) => workspacesRename(payload),
    'workspaces/forget': (payload) => workspacesForget(payload),
    'workspaces/observe': (payload) => workspacesObserve(payload),
    'jobs/list': () => jobsList(),
    'jobs/cancel': (payload) => jobsCancel(payload),
    'settings/set': (payload) => settingsSet(payload),
    'fs/reveal': (payload) => fsReveal(payload),
  })

  /** Methods that change durable state (and therefore need a live core). */
  const MUTATING_METHODS = new Set([
    'repos/save', 'repos/remove', 'workspaces/create', 'workspaces/archive',
    'workspaces/restore', 'workspaces/rename', 'workspaces/forget', 'settings/set',
  ])

  return {
    /**
     * The single entry point: validate the method, await readiness, and run it.
     * @param method - one of the PROTOCOL.md method strings.
     * @param payload - the request payload; absent means `{}`.
     * @returns {Promise<object>} the documented `value`.
     * @throws {import('./host/errors.js').WorkspaceManagerError} the documented `error`.
     */
    async dispatch(method, payload) {
      const requested = typeof method === 'string' ? method : ''
      if (!Object.prototype.hasOwnProperty.call(endpoints, requested)) {
        throw fail(CODES.unknownMethod, `未知的操作：${requested.length > 0 ? requested : '(空)'}`)
      }
      await start()
      if (closed && MUTATING_METHODS.has(requested)) {
        throw fail(CODES.unsupported, '工作区管理器已经关闭，无法再修改状态')
      }
      return await endpoints[requested](payload === undefined || payload === null ? {} : payload)
    },

    /**
     * Load the store from disk and seed a fresh one from the loader row.
     * Idempotent, and awaited internally by `dispatch`.
     * @returns {Promise<void>} resolution once ready.
     */
    start,

    /**
     * Stop accepting new jobs, terminate running git children, and flush a
     * store whose last write failed. Idempotent.
     * @returns {Promise<void>} resolution once everything settled.
     */
    async close() {
      if (closed) return
      closed = true
      runner.close()
      if (storeWriteError() !== null) storeOf().write(storeOf().read())
    },

    /**
     * Subscribe to snapshot changes: the stored records plus the job list,
     * published after every commit and every job settlement. Observations are
     * not run, so a listener is cheap.
     * @param listener - receives the current `{ repos, items, jobs, settings }`.
     * @returns {() => void} the unsubscribe function.
     */
    onChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('workspaceManager: onChange 需要一个监听函数')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Wire the core into Cordis: provide the `workspaceManager` service, open the
 * store, and register the browser-facing RPC channel. The route is a thin
 * wrapper over `core.dispatch` and adds nothing but the envelope.
 * @param ctx - the plugin context.
 * @param config - the validated row config (all fields optional).
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config ?? {})
  const store = createStore({ file: storageFileFor({ override: resolved.storageFile }), logger: ctx.logger })
  const core = createWorkspaceManagerCore({
    getSubprocess: () => ctx.get('subprocess'),
    getWorkspaceRegistry: () => ctx.get('workspaceRegistry'),
    logger: ctx.logger,
    config: resolved,
    store,
  })

  ctx.provide('workspaceManager', core)

  ctx.effect(() => {
    const unsubscribe = core.onChange((change) => {
      ctx.logger?.debug?.(
        `workspaceManager: 记录已更新（repos=${change.repos.length}, items=${change.items.length}, jobs=${change.jobs.length}）`,
      )
    })
    void core.start().catch((error) => {
      ctx.logger?.warn?.(`workspaceManager: 初始化失败：${message(error)}`)
    })
    return () => {
      unsubscribe()
      return core.close()
    }
  }, 'workspaceManager: store, job, and change lifecycle')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      /** Reply with the Connection response envelope the browser caller expects. */
      const respond = (rpcId, result, status = 200) => {
        const body = JSON.stringify({ type: 'server-response', rpcId, result })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      }
      let rpcId = ''
      try {
        const endpoint = new URL(req.url ?? '/', 'http://workspace-manager.invalid').pathname
          .slice(CHANNEL.length)
          .replace(/^\//, '')
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_REQUEST_BYTES) throw new Error('请求体过大')
          chunks.push(chunk)
        }
        const envelope = asObject(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        rpcId = boundedText(envelope.rpcId, 200)
        const method = boundedText(envelope.method, 200)
        if (envelope.type !== 'client-request' || rpcId.length === 0 || method !== endpoint) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('bad request envelope')
          return
        }
        respond(rpcId, { ok: true, value: await core.dispatch(endpoint, envelope.payload) })
      } catch (error) {
        ctx.logger?.warn?.(`workspaceManager: 请求失败：${message(error)}`)
        if (rpcId.length === 0) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('bad request')
          return
        }
        respond(rpcId, { ok: false, error: toWireError(error) })
      }
    },
  }), `workspaceManager: ${CHANNEL} route`)
}
