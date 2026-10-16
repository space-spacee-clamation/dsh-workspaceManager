// Host-half verification. Every assertion below is derived from
// `docs/PROTOCOL.md` (the frozen wire contract, including the "Host core
// surface (the test seam)" section) and drives the real git engine against a
// throwaway fixture: a repository cloned from a bare remote under
// `os.tmpdir()`, a fake `workspaceRegistry`, and the `subprocess` capability
// adapter from `tests/helpers/subprocess.mjs`.
//
// Two independent claims are proven separately:
//   1. the domain, through `core.dispatch(method, payload)` (the frozen seam);
//   2. the transport, through the handler registered on a fake `webServer`.

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  currentBranch,
  delay,
  exists,
  isolateHome,
  logCommits,
  makeFakeCtx,
  makeRemote,
  readJson,
  removeDir,
  requestRoute,
  tempDir,
} from './helpers/repo.mjs'
import { createGitSubprocess, trackConcurrency } from './helpers/subprocess.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOME_GUARD = isolateHome()
after(() => HOME_GUARD.restore())

/** @param value - a path. @returns it with every resolvable ancestor canonicalized. */
function canonicalPath(value) {
  const resolved = path.resolve(value)
  for (let dir = resolved; ; dir = path.dirname(dir)) {
    if (exists(dir)) return path.join(fs.realpathSync.native(dir), path.relative(dir, resolved))
    if (path.dirname(dir) === dir) return resolved
  }
}

/** @param value - a path. @returns whether it lives inside `os.tmpdir()`. */
function underTemporary(value) {
  const relative = path.relative(fs.realpathSync.native(os.tmpdir()), canonicalPath(value))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

let hostModulePromise = null
/** @returns the imported `src/host.js` module namespace. */
function loadHostModule() {
  hostModulePromise ??= import(pathToFileURL(path.join(ROOT, 'src', 'host.js')).href)
  return hostModulePromise
}

/** @param dir - temp directory. @param overrides - config overrides. @returns the normalized config. */
function coreConfig(dir, overrides = {}) {
  return {
    storageFile: path.join(dir, 'workspace-manager.json'),
    concurrency: 1,
    deleteDirectoryOnArchive: false,
    ...overrides,
  }
}

/**
 * Build the fixture half of a boot: temp dir, git remote, subprocess adapter,
 * fake context.
 * @param t - the node:test context.
 * @param options - overrides.
 * @returns `{ dir, remote, subprocess, harness }`.
 */
function makeFixture(t, options = {}) {
  const dir = options.dir ?? tempDir('dsh-wm-case-')
  if (options.dir === undefined) t.after(() => removeDir(dir))
  const remote = options.remote ?? makeRemote()
  if (options.remote === undefined) t.after(() => remote.cleanup())
  const subprocess = options.subprocess ?? createGitSubprocess()
  const harness = makeFakeCtx({
    config: coreConfig(dir, options.config),
    subprocess,
    workspaceRegistry: options.workspaceRegistry,
    admitted: options.admitted,
    admit: options.admit,
    services: options.services,
  })
  return { dir, remote, subprocess, harness }
}

/**
 * Boot the domain through `createWorkspaceManagerCore` — the frozen test seam.
 * @param t - the node:test context.
 * @param options - fixture/config overrides.
 * @returns the boot.
 */
async function bootCore(t, options = {}) {
  const { dir, remote, subprocess, harness } = makeFixture(t, options)
  const module = await loadHostModule()
  assert.equal(typeof module.createWorkspaceManagerCore, 'function', 'src/host.js must export createWorkspaceManagerCore')
  const core = module.createWorkspaceManagerCore({
    getSubprocess: options.getSubprocess ?? (() => subprocess),
    getWorkspaceRegistry: options.getWorkspaceRegistry ?? (() => harness.workspaceRegistry),
    logger: harness.logger,
    config: harness.config,
    ...(options.store === undefined ? {} : { store: options.store }),
  })
  assert.ok(core !== null && typeof core === 'object', 'createWorkspaceManagerCore must return a core')
  for (const member of ['dispatch', 'start', 'close', 'onChange']) {
    assert.equal(typeof core[member], 'function', `the core must expose ${member}()`)
  }
  if (options.started !== false) await core.start()
  t.after(async () => {
    try {
      await core.close()
    } catch {
      // Teardown failures are not what these specs assert.
    }
  })
  const boot = { core, harness, remote, dir, subprocess, module }
  const state = await rpc(boot, 'state', {})
  assert.equal(typeof state?.stores?.file, 'string', 'state.stores.file must be the absolute store path')
  assert.equal(
    underTemporary(state.stores.file),
    true,
    `the JSON store must stay inside os.tmpdir() during tests, received ${state.stores.file}`,
  )
  assert.equal(canonicalPath(state.stores.file), canonicalPath(harness.config.storageFile), 'config.storageFile must pin the store')
  return boot
}

/**
 * Boot the whole plugin through `apply(ctx, config)` so its route is
 * registered on the fake web server.
 * @param t - the node:test context.
 * @param options - fixture/config overrides.
 * @returns the boot.
 */
async function bootPlugin(t, options = {}) {
  const { dir, remote, subprocess, harness } = makeFixture(t, options)
  const module = await loadHostModule()
  assert.equal(typeof module.apply, 'function', 'src/host.js must export apply')
  const dispose = await module.apply(harness.ctx, harness.config)
  t.after(async () => {
    if (typeof dispose === 'function') await dispose()
  })
  const boot = { core: null, harness, remote, dir, subprocess, module, dispose }
  const routes = harness.records.routes
  assert.equal(routes.length, 1, 'apply must register exactly one route')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path.replace(/\/+$/, ''), '/workspace-manager')
  if (options.admitted !== false && options.admit === undefined) {
    const state = await rpc(boot, 'state', {})
    assert.equal(underTemporary(state.stores.file), true, `the JSON store must stay inside os.tmpdir(), received ${state.stores.file}`)
  }
  return boot
}

/**
 * Invoke one RPC method. The direct dispatch surface is the primary path; the
 * HTTP route is used only for the plugin boot, where no core is handed out.
 * @param boot - a live boot.
 * @param method - RPC method from the PROTOCOL table.
 * @param payload - request payload.
 * @returns the documented `value`.
 */
async function rpc(boot, method, payload = {}) {
  if (boot.core !== null) return await boot.core.dispatch(method, payload)
  return rpcOverRoute(boot, method, payload)
}

let rpcSequence = 0
/** @param boot - a plugin boot. @param method - RPC method. @param payload - request payload. @returns the `value`. */
async function rpcOverRoute(boot, method, payload = {}) {
  const base = boot.harness.records.routes[0].path.replace(/\/+$/, '')
  const rpcId = `verify-${++rpcSequence}`
  const { res } = await requestRoute(boot.harness, {
    method: 'POST',
    url: `${base}/${method}`,
    body: { type: 'client-request', rpcId, method, payload },
  })
  assert.equal(res.statusCode, 200, `expected HTTP 200 for ${method}, received ${res.statusCode}: ${res.body}`)
  const envelope = res.json()
  assert.equal(envelope?.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId, 'the responder must echo rpcId')
  assert.equal(envelope.result.ok, true, `route ${method} failed: ${envelope.result.error?.message}`)
  return envelope.result.value
}

/**
 * @param boot - a live boot.
 * @param id - job id.
 * @param timeoutMs - bound on the wait.
 * @returns the settled job.
 */
async function waitForJob(boot, id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { jobs } = await rpc(boot, 'jobs/list', {})
    const job = jobs.find((candidate) => candidate.id === id) ?? null
    assert.ok(job !== null, `jobs/list does not know job ${id}`)
    if (job.status !== 'running') return job
    if (Date.now() > deadline) {
      throw new Error(`job ${id} still "${job.status}" after ${timeoutMs}ms; log=${JSON.stringify(job.log)}`)
    }
    await delay(20)
  }
}

/**
 * @param promise - the dispatch promise expected to reject.
 * @param code - the required `workspace-manager/*` discriminant.
 * @returns the rejection.
 */
async function expectRpcError(promise, code) {
  let rejection = null
  try {
    await promise
  } catch (error) {
    rejection = error
  }
  assert.ok(rejection !== null, `expected a rejection carrying ${code}`)
  assert.equal(rejection.code, code, `expected ${code}, received ${rejection.code}: ${rejection.message}`)
  assert.equal(typeof rejection.message, 'string')
  assert.ok(rejection.message.length > 0, 'a rejection must carry a human message')
  return rejection
}

/** @param boot - a live boot. @param request - a CreateRequest. @returns the settled job. */
async function createWorkspace(boot, request) {
  const { job } = await rpc(boot, 'workspaces/create', request)
  assert.ok(job !== null && typeof job === 'object', 'workspaces/create must answer with { job }')
  assert.equal(job.kind, 'create')
  assert.equal(typeof job.id, 'string')
  return waitForJob(boot, job.id)
}

/** @param boot - a live boot. @param id - WorkspaceItem id. @returns the item from `state`. */
async function itemById(boot, id) {
  const { items } = await rpc(boot, 'state', {})
  const item = items.find((candidate) => candidate.id === id) ?? null
  assert.ok(item !== null, `state.items has no item ${id}`)
  return item
}

/** @param boot - a live boot. @param name - parent directory name. @returns its path. */
function makeParent(boot, name) {
  const parent = path.join(boot.dir, name)
  fs.mkdirSync(parent, { recursive: true })
  return parent
}

/** @param request - the create request under test. @returns its explicit clone path. */
function expectedPath(request) {
  return path.join(request.parentDir, request.directoryName)
}

test('repos/branches reports every branch and the remote default head', async (t) => {
  const boot = await bootCore(t)
  const result = await rpc(boot, 'repos/branches', { url: boot.remote.url })
  assert.deepEqual([...result.branches].sort(), ['develop', 'main'])
  assert.equal(result.head, 'main', 'the bare clone of the fixture is on main')
})

test('workspaces/create clones the branch and registers the workspace', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')
  const request = {
    url: boot.remote.url,
    baseBranch: 'develop',
    parentDir,
    name: 'alpha',
    branch: 'wm/alpha',
    directoryName: 'alpha-dir',
    title: 'Alpha workspace',
  }
  const job = await createWorkspace(boot, request)
  assert.equal(job.status, 'ok', `create failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
  assert.equal(typeof job.resultId, 'string')
  assert.ok(Array.isArray(job.log), 'Job.log must be an array')

  const item = await itemById(boot, job.resultId)
  assert.equal(canonicalPath(item.path), canonicalPath(expectedPath(request)), 'the clone must land on <parentDir>/<directoryName>')
  assert.equal(exists(item.path), true, 'the clone directory must exist')
  assert.equal(fs.statSync(item.path).isDirectory(), true)
  assert.equal(currentBranch(item.path), 'wm/alpha', 'the requested branch must be checked out in the clone')
  assert.equal(item.branch, 'wm/alpha')
  assert.equal(item.name, 'alpha')
  assert.equal(item.title, 'Alpha workspace')
  assert.equal(item.archived, false)
  assert.equal(item.archivedAt, null)
  assert.equal(item.baseBranch, 'develop')
  assert.equal(item.repoUrl, boot.remote.url)
  assert.equal(typeof item.workspaceId, 'string', 'a created workspace is registered, so workspaceId is set')
  assert.equal(underTemporary(item.path), true, 'the clone must stay inside os.tmpdir()')

  const creates = boot.harness.records.registryCalls.filter((call) => call.op === 'create')
  assert.equal(creates.length, 1, 'exactly one workspaceRegistry.create call')
  assert.equal(canonicalPath(creates[0].args[0]), canonicalPath(item.path), 'registry.create(path, title) must receive the real clone path')
  assert.equal(creates[0].args[1], 'Alpha workspace')
  assert.equal(boot.harness.workspaceRegistry.items.has(item.workspaceId), true, 'workspaceId must name a live registry record')
})

test('creating into a non-empty directory fails with path-exists and leaves it untouched', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')
  const occupied = path.join(parentDir, 'occupied')
  fs.mkdirSync(occupied, { recursive: true })
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep\n')
  const before = fs.readdirSync(occupied).sort()

  const request = {
    url: boot.remote.url,
    baseBranch: 'develop',
    parentDir,
    name: 'beta',
    branch: 'wm/beta',
    directoryName: 'occupied',
    title: 'Beta workspace',
  }

  const settled = await rpc(boot, 'workspaces/create', request).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  if (settled.error !== undefined) {
    assert.equal(settled.error.code, 'workspace-manager/path-exists')
  } else {
    const job = await waitForJob(boot, settled.value.job.id)
    assert.equal(job.status, 'failed', 'a create into an occupied directory must not succeed')
    assert.match(JSON.stringify(job), /path-exists/, 'the failed job must carry the path-exists discriminant')
  }

  assert.deepEqual(fs.readdirSync(occupied).sort(), before, 'the existing directory must not be touched')
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep\n')
  const { items } = await rpc(boot, 'state', {})
  assert.equal(items.length, 0, 'a failed create must not register a workspace')
})

test('the work branch is really based on the base branch', async (t) => {
  const boot = await bootCore(t)
  const marker = boot.remote.commitOn('develop', 'base-marker.txt', 'second develop commit')
  const parentDir = makeParent(boot, 'parent')
  const job = await createWorkspace(boot, {
    url: boot.remote.url,
    baseBranch: 'develop',
    parentDir,
    name: 'gamma',
    branch: 'wm/gamma',
    directoryName: 'gamma',
    title: 'Gamma workspace',
  })
  assert.equal(job.status, 'ok', `create failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
  const item = await itemById(boot, job.resultId)
  assert.equal(logCommits(item.path).includes(marker), true, 'the clone must contain the commit made on develop before the create')
  assert.equal(currentBranch(item.path), 'wm/gamma')
})

test('workspaces/archive unregisters, keeps the directory, and honors deleteDirectory', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')
  const made = {}
  for (const name of ['archived', 'removed']) {
    const job = await createWorkspace(boot, {
      url: boot.remote.url,
      baseBranch: 'develop',
      parentDir,
      name,
      branch: `wm/${name}`,
      directoryName: name,
      title: `${name} workspace`,
    })
    assert.equal(job.status, 'ok', `create ${name} failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
    made[name] = await itemById(boot, job.resultId)
  }

  const first = await rpc(boot, 'workspaces/archive', { id: made.archived.id })
  await waitForJob(boot, first.job.id)
  const archived = await itemById(boot, made.archived.id)
  assert.equal(archived.archived, true)
  assert.equal(archived.workspaceId, null, 'an archived item is no longer registered')
  assert.equal(typeof archived.archivedAt, 'string')
  assert.equal(exists(archived.path), true, 'a plain archive keeps the directory on disk')
  assert.equal(
    boot.harness.records.registryCalls.some((call) => call.op === 'delete' && call.args[0] === made.archived.workspaceId),
    true,
    'archive must call registry.delete(workspaceId)',
  )

  const withDirectory = await rpc(boot, 'workspaces/archive', { id: made.removed.id, deleteDirectory: true })
  await waitForJob(boot, withDirectory.job.id)
  const removed = await itemById(boot, made.removed.id)
  assert.equal(removed.archived, true)
  assert.equal(exists(removed.path), false, 'deleteDirectory: true must remove the clone directory')
})

test('workspaces/restore re-registers the workspace', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')
  const job = await createWorkspace(boot, {
    url: boot.remote.url,
    baseBranch: 'develop',
    parentDir,
    name: 'delta',
    branch: 'wm/delta',
    directoryName: 'delta',
    title: 'Delta workspace',
  })
  const created = await itemById(boot, job.resultId)
  const archivedJob = await rpc(boot, 'workspaces/archive', { id: created.id })
  await waitForJob(boot, archivedJob.job.id)
  assert.equal((await itemById(boot, created.id)).archived, true)

  const { item } = await rpc(boot, 'workspaces/restore', { id: created.id })
  assert.equal(item.archived, false)
  assert.equal(item.archivedAt, null)
  assert.equal(typeof item.workspaceId, 'string')
  assert.equal(
    boot.harness.records.registryCalls.filter((call) => call.op === 'create').length,
    2,
    'restore must register the workspace again',
  )
  const reread = await itemById(boot, created.id)
  assert.equal(reread.archived, false)
  assert.equal(reread.workspaceId, item.workspaceId)
})

test('a failed job carries the git-failed code while a successful job carries none', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')

  const submitted = await rpc(boot, 'workspaces/create', {
    url: boot.remote.url, baseBranch: 'develop', parentDir, name: 'theta', branch: 'wm/theta', directoryName: 'theta', title: 'Theta workspace',
  })
  assert.equal(submitted.job.status, 'running', 'create answers with the job before the work runs')
  assert.equal(submitted.job.code, null, 'a running job carries no failure code')
  const ok = await waitForJob(boot, submitted.job.id)
  assert.equal(ok.status, 'ok', `create failed: ${ok.error}\nlog=${JSON.stringify(ok.log)}`)
  assert.equal(ok.code, null, 'a successful job carries no failure code')
  assert.equal(ok.error, null, 'a successful job carries no error')

  const missing = path.join(boot.dir, 'no-such-remote')
  const failing = await rpc(boot, 'workspaces/create', {
    url: missing, baseBranch: 'main', parentDir, name: 'epsilon', branch: 'wm/epsilon', directoryName: 'epsilon', title: 'Epsilon workspace',
  })
  const job = await waitForJob(boot, failing.job.id)
  assert.equal(job.status, 'failed')
  assert.equal(
    job.code,
    'workspace-manager/git-failed',
    `a background failure is only observable through the job, so it must keep the stable code: ${JSON.stringify(job)}`,
  )
  assert.equal(typeof job.error, 'string')
  assert.ok(job.error.length > 0, 'a failed job must carry a non-empty error')
  assert.equal(job.error.includes('git-failed'), false, 'error is the human message and never repeats the code')
  assert.equal(typeof job.endedAt, 'string', 'a settled job carries endedAt')
  assert.equal(job.resultId, null, 'a job that produced nothing has no resultId')
})

test('the JSON store round-trips into a second core over the same file', async (t) => {
  const dir = tempDir('dsh-wm-store-')
  t.after(() => removeDir(dir))
  const remote = makeRemote()
  t.after(() => remote.cleanup())
  const first = await bootCore(t, { dir, remote })
  const parentDir = makeParent(first, 'parent')
  const { repo } = await rpc(first, 'repos/save', {
    repo: { url: remote.url, name: 'Fixture repo', baseBranch: 'develop', parentDir },
  })
  assert.equal(typeof repo?.id, 'string', 'repos/save must answer with the stored Repo')
  assert.equal(repo.url, remote.url)
  const job = await createWorkspace(first, {
    repoId: repo.id,
    name: 'zeta',
    branch: 'wm/zeta',
    directoryName: 'zeta',
    title: 'Zeta workspace',
  })
  assert.equal(job.status, 'ok', `create failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
  const before = await rpc(first, 'state', {})
  assert.equal(exists(before.stores.file), true, 'the store file must exist after a write')
  assert.ok(readJson(before.stores.file).repos.length > 0, 'the store file must hold the saved repo')

  const second = await bootCore(t, { dir, remote })
  const after = await rpc(second, 'state', {})
  assert.equal(canonicalPath(after.stores.file), canonicalPath(before.stores.file), 'both cores must read one store file')
  assert.deepEqual(
    after.repos.map((entry) => [entry.id, entry.url, entry.baseBranch, entry.parentDir]),
    before.repos.map((entry) => [entry.id, entry.url, entry.baseBranch, entry.parentDir]),
  )
  assert.deepEqual(
    after.items.map((entry) => [entry.id, entry.path, entry.branch, entry.workspaceId, entry.archived]),
    before.items.map((entry) => [entry.id, entry.path, entry.branch, entry.workspaceId, entry.archived]),
  )
  assert.equal(typeof after.stores.gitVersion, 'string', 'StoreInfo.gitVersion must report the resolved git')
  assert.equal(after.stores.writeError, null)
})

test('dispatch works before start(), and start() is idempotent', async (t) => {
  const boot = await bootCore(t, { started: false })
  const first = await rpc(boot, 'state', {})
  assert.ok(Array.isArray(first.items))
  await boot.core.start()
  await boot.core.start()
  const second = await rpc(boot, 'state', {})
  assert.deepEqual(second.items, first.items)
})

test('onChange notifies subscribers and returns an unsubscribe function', async (t) => {
  const boot = await bootCore(t)
  const seen = []
  const unsubscribe = boot.core.onChange((snapshot) => seen.push(snapshot))
  assert.equal(typeof unsubscribe, 'function')
  await rpc(boot, 'repos/save', { repo: { url: boot.remote.url, name: 'Notify', baseBranch: 'main', parentDir: boot.dir } })
  assert.ok(seen.length >= 1, 'a store change must notify onChange listeners')
  unsubscribe()
  const after = seen.length
  await rpc(boot, 'repos/save', { repo: { url: boot.remote.url, name: 'Notify 2', baseBranch: 'main', parentDir: boot.dir } })
  assert.equal(seen.length, after, 'the returned unsubscribe must stop delivery')
})

test('an absent subprocess capability answers no-git', async (t) => {
  const boot = await bootCore(t, { getSubprocess: () => undefined })
  await expectRpcError(rpc(boot, 'repos/branches', { url: boot.remote.url }), 'workspace-manager/no-git')
  const state = await rpc(boot, 'state', {})
  assert.equal(state.stores.gitPath, null)
  assert.equal(state.stores.gitVersion, null)
})

test('an absent workspaceRegistry answers registry-unavailable', async (t) => {
  const boot = await bootCore(t, { getWorkspaceRegistry: () => undefined })
  const parentDir = makeParent(boot, 'parent')
  const settled = await rpc(boot, 'workspaces/create', {
    url: boot.remote.url,
    baseBranch: 'develop',
    parentDir,
    name: 'unregistered',
    branch: 'wm/unregistered',
    directoryName: 'unregistered',
    title: 'Unregistered workspace',
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  if (settled.error !== undefined) {
    assert.equal(settled.error.code, 'workspace-manager/registry-unavailable')
  } else {
    const job = await waitForJob(boot, settled.value.job.id)
    assert.equal(job.status, 'failed')
    assert.match(JSON.stringify(job), /registry-unavailable/)
  }
})

test('the remaining record methods round-trip', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')
  const { repo } = await rpc(boot, 'repos/save', {
    repo: { url: boot.remote.url, name: 'Removable', baseBranch: 'develop', parentDir },
  })
  const { removed } = await rpc(boot, 'repos/remove', { id: repo.id })
  assert.equal(removed, true)
  assert.equal((await rpc(boot, 'state', {})).repos.some((entry) => entry.id === repo.id), false, 'a removed repo leaves the store')

  const job = await createWorkspace(boot, {
    url: boot.remote.url, baseBranch: 'develop', parentDir, name: 'rename-me', branch: 'wm/rename', directoryName: 'rename-me', title: 'Rename me',
  })
  assert.equal(job.status, 'ok', `create failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
  const created = await itemById(boot, job.resultId)
  const { item: renamed } = await rpc(boot, 'workspaces/rename', { id: created.id, name: 'renamed', title: 'Renamed title' })
  assert.equal(renamed.name, 'renamed')
  assert.equal(renamed.title, 'Renamed title')
  assert.equal((await itemById(boot, created.id)).title, 'Renamed title', 'the rename must persist to the store')
})

test('workspaces/forget archives, drops the record, and optionally removes the directory', async (t) => {
  const boot = await bootCore(t)
  const parentDir = makeParent(boot, 'parent')
  const job = await createWorkspace(boot, {
    url: boot.remote.url, baseBranch: 'develop', parentDir, name: 'forgotten', branch: 'wm/forgotten', directoryName: 'forgotten', title: 'Forgotten workspace',
  })
  assert.equal(job.status, 'ok', `create failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
  const created = await itemById(boot, job.resultId)

  const { job: forget } = await rpc(boot, 'workspaces/forget', { id: created.id, deleteDirectory: true })
  assert.equal(forget.kind, 'archive', 'forget is the archive arm of the closed Job.kind union')
  const settled = await waitForJob(boot, forget.id)
  assert.equal(settled.status, 'ok', `forget failed: ${settled.error}\nlog=${JSON.stringify(settled.log)}`)
  const { items } = await rpc(boot, 'state', {})
  assert.equal(items.some((entry) => entry.id === created.id), false, 'a forgotten workspace drops its record')
  assert.equal(exists(created.path), false, 'deleteDirectory: true removes the clone on forget')
  assert.equal(
    boot.harness.records.registryCalls.some((call) => call.op === 'delete' && call.args[0] === created.workspaceId),
    true,
    'forget must unregister the workspace first',
  )
})

test('validation and lookup failures use the documented codes', async (t) => {
  const boot = await bootCore(t)
  await expectRpcError(rpc(boot, 'repos/branches', {}), 'workspace-manager/bad-request')
  await expectRpcError(rpc(boot, 'workspaces/rename', { id: 'no-such-item', name: 'x' }), 'workspace-manager/not-found')
  await expectRpcError(rpc(boot, 'not-a-method', {}), 'workspace-manager/unknown-method')
})

test('concurrency: 1 never lets two git jobs overlap', async (t) => {
  const dir = tempDir('dsh-wm-concurrency-')
  t.after(() => removeDir(dir))
  const remote = makeRemote()
  t.after(() => remote.cleanup())
  const tracked = trackConcurrency(createGitSubprocess(), { lingerMs: 10 })
  const boot = await bootCore(t, { dir, remote, subprocess: tracked, config: { concurrency: 1 } })
  const { settings } = await rpc(boot, 'settings/set', { patch: { concurrency: 1 } })
  assert.equal(settings.concurrency, 1)
  const parentDir = makeParent(boot, 'parent')

  const results = await Promise.allSettled([
    rpc(boot, 'workspaces/create', {
      url: remote.url, baseBranch: 'develop', parentDir, name: 'one', branch: 'wm/one', directoryName: 'one', title: 'One',
    }),
    rpc(boot, 'workspaces/create', {
      url: remote.url, baseBranch: 'develop', parentDir, name: 'two', branch: 'wm/two', directoryName: 'two', title: 'Two',
    }),
  ])

  const calls = tracked.calls.map((call) => `${call.args.join(' ')} [${call.startedAt}..${call.endedAt ?? '?'}]`)
  assert.equal(
    tracked.state.maxActive,
    1,
    `concurrency 1 spawned ${tracked.state.maxActive} git processes at once\n${calls.join('\n')}`,
  )

  const accepted = results.filter((result) => result.status === 'fulfilled')
  const refused = results.filter((result) => result.status === 'rejected')
  assert.ok(accepted.length >= 1, 'at least one create must be accepted')
  for (const result of refused) {
    assert.equal(result.reason.code, 'workspace-manager/busy', `a create refused by the limit must answer busy, received ${result.reason.code}`)
  }
  for (const result of accepted) {
    const job = await waitForJob(boot, result.value.job.id)
    assert.equal(job.status, 'ok', `create failed: ${job.error}\nlog=${JSON.stringify(job.log)}`)
  }
})

test('the prefix route answers the frozen envelope', async (t) => {
  const boot = await bootPlugin(t)
  const base = boot.harness.records.routes[0].path.replace(/\/+$/, '')
  const post = (endpoint, body) => requestRoute(boot.harness, { method: 'POST', url: `${base}/${endpoint}`, body })

  const ok = await post('state', { type: 'client-request', rpcId: 'r-ok', method: 'state', payload: {} })
  assert.equal(ok.res.statusCode, 200)
  const okBody = ok.res.json()
  assert.equal(okBody.type, 'server-response')
  assert.equal(okBody.rpcId, 'r-ok')
  assert.equal(okBody.result.ok, true)
  assert.ok(Array.isArray(okBody.result.value.items))
  assert.ok(Array.isArray(okBody.result.value.repos))
  assert.ok(Array.isArray(okBody.result.value.jobs))
  assert.equal(typeof okBody.result.value.settings, 'object')
  assert.equal(typeof okBody.result.value.stores, 'object')

  const parentDir = makeParent(boot, 'parent')
  const created = await post('workspaces/create', {
    type: 'client-request',
    rpcId: 'r-create',
    method: 'workspaces/create',
    payload: {
      url: boot.remote.url, baseBranch: 'develop', parentDir, name: 'eta', branch: 'wm/eta', directoryName: 'eta', title: 'Eta workspace',
    },
  })
  assert.equal(created.res.statusCode, 200)
  const createdBody = created.res.json()
  assert.equal(createdBody.result.ok, true)
  assert.equal(typeof createdBody.result.value.job.id, 'string')
  assert.equal(createdBody.result.value.job.kind, 'create')
  const settled = await waitForJob(boot, createdBody.result.value.job.id)
  assert.equal(settled.status, 'ok', `create failed: ${settled.error}\nlog=${JSON.stringify(settled.log)}`)

  const mismatch = await post('state', { type: 'client-request', rpcId: 'r-bad', method: 'repos/branches', payload: {} })
  assert.equal(mismatch.res.statusCode, 400, 'method must equal the URL endpoint')
  assert.ok(mismatch.res.body.length > 0, 'a malformed envelope answers with a body')

  const malformed = await requestRoute(boot.harness, { method: 'POST', url: `${base}/state`, body: 'not json' })
  assert.equal(malformed.res.statusCode, 400)

  const notAllowed = await requestRoute(boot.harness, { method: 'GET', url: `${base}/state` })
  assert.equal(notAllowed.res.statusCode, 405)
  const allow = notAllowed.res.headers?.allow ?? notAllowed.res.headers?.Allow
  if (allow !== undefined) assert.match(String(allow).toUpperCase(), /POST/)

  const unknown = await post('nope', { type: 'client-request', rpcId: 'r-unknown', method: 'nope', payload: {} })
  const unknownBody = unknown.res.json()
  assert.equal(unknownBody.result.ok, false)
  assert.equal(unknownBody.result.error.code, 'workspace-manager/unknown-method')
})

test('an unadmitted request is refused with the admission status', async (t) => {
  const refused = await bootPlugin(t, { admitted: false })
  const base = refused.harness.records.routes[0].path.replace(/\/+$/, '')
  const response = await requestRoute(refused.harness, {
    method: 'POST',
    url: `${base}/state`,
    body: { type: 'client-request', rpcId: 'r-admit', method: 'state', payload: {} },
  })
  assert.equal(response.res.statusCode, 401, 'the untrusted rejection status must be propagated')

  const forbidden = await bootPlugin(t, { admit: () => ({ rejection: 403 }) })
  const base403 = forbidden.harness.records.routes[0].path.replace(/\/+$/, '')
  const denied = await requestRoute(forbidden.harness, {
    method: 'POST',
    url: `${base403}/state`,
    body: { type: 'client-request', rpcId: 'r-admit2', method: 'state', payload: {} },
  })
  assert.equal(denied.res.statusCode, 403, 'the handler must propagate the rejection it was given, not hardcode 401')
})
