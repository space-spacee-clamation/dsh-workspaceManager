# Frozen wire contract — dsh-workspace-manager

This document is the single source of truth shared by the Host half
(`src/host*.js`) and the browser half (`src/client.js`). Neither half may change
a method name, request field, or response field without updating this file
first.

## Transport

The Host half registers one prefix route on `ctx.webServer`:

```
POST <origin>/workspace-manager/<method>
```

It is the same envelope `dsh-todonote` uses, and it is admitted through
`ctx.connection.admit(req)` before anything else runs.

Request body (JSON):

```jsonc
{ "type": "client-request", "rpcId": "<client-minted>", "method": "<method>", "payload": { } }
```

`method` MUST equal the endpoint taken from the URL path.

Response body (JSON), always HTTP 200 once the envelope is valid:

```jsonc
{ "type": "server-response", "rpcId": "<echoed>", "result": { "ok": true, "value": { } } }
{ "type": "server-response", "rpcId": "<echoed>", "result": { "ok": false, "error": { "code": "...", "message": "...", "details": {} } } }
```

Malformed envelopes answer HTTP 400/405 with a plain-text body.

## Domain records

### `Repo`

A saved repository preset: "clone this remote into a new folder, branch off
this base branch".

```ts
interface Repo {
  id: string            // stable slug, unique within the store
  name: string          // display name shown in the panel
  url: string           // remote URL or local path accepted by `git clone`
  baseBranch: string    // branch the new work branch is created from
  parentDir: string     // default parent directory for this repo's clones ('' = inherit settings)
  createdAt: string     // ISO-8601
  updatedAt: string     // ISO-8601
}
```

### `WorkspaceItem`

One managed sub-workspace: a directory that was cloned, branched, and
registered into the DSH workspace list.

```ts
interface WorkspaceItem {
  id: string            // our own stable record id
  workspaceId: string | null   // DSH WorkspaceId while registered; null after archive
  name: string          // user-given short name
  title: string         // DSH workspace title
  path: string          // absolute directory of the clone
  repoId: string | null
  repoName: string
  repoUrl: string
  baseBranch: string
  branch: string
  archived: boolean
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  status: ItemStatus    // observed lazily; never persisted
}

interface ItemStatus {
  exists: boolean       // the directory is still there
  registered: boolean   // the DSH workspace registration is still there
  branch: string | null // current branch read from the directory
  dirty: boolean        // `git status --porcelain` produced output
  ahead: number         // commits ahead of the upstream, -1 when unknown
  behind: number        // commits behind the upstream, -1 when unknown
  error: string | null  // why the observation failed, when it did
}
```

### `Job`

Every mutating operation that shells out (`create`, `archive`) runs as one job.
The client polls `jobs/list` while any job is running.

```ts
interface Job {
  id: string
  kind: 'create' | 'archive'
  label: string         // human-readable subject, e.g. the branch name
  status: 'running' | 'ok' | 'failed' | 'cancelled'
  step: string          // current step, localized on the Host
  progress: number      // 0..1, or -1 while indeterminate
  log: JobLogEntry[]
  startedAt: string
  endedAt: string | null
  error: string | null      // the localized human message, or null
  code: string | null       // the stable `workspace-manager/*` code of the failure, or null
  resultId: string | null   // WorkspaceItem id the job produced
}

interface JobLogEntry { at: string; level: 'info' | 'warn' | 'error'; text: string }
```

`workspaces/create` reports `kind: 'create'`. `workspaces/archive` and
`workspaces/forget` both report `kind: 'archive'`: forgetting is an archive that
also drops the record, and the discriminant stays a closed two-arm union rather
than growing an arm with one producer.

A job is the ONLY failure channel for `workspaces/create`, `workspaces/archive`
and `workspaces/forget`, because those answer with the job before the work runs.
`code` therefore carries the same stable discriminant the synchronous methods
reject with, so a client can branch on the failure kind instead of reading the
localized `error` text. `code` is `null` while the job is running, when it
succeeded, and when it was cancelled; `error` stays the human message and never
repeats the code.

### `Settings`

```ts
interface Settings {
  defaultParentDir: string          // where clones land when nothing else is set
  directoryTemplate: string         // '{repo}-{name}', '{repo}/{name}', ...
  branchPrefix: string              // prepended to the branch when the user types none
  cloneDepth: number                // 0 = full history, else `--depth <n>`
  partialClone: boolean             // `--filter=blob:none` (ignored when cloneDepth > 0)
  fetchBeforeCreate: boolean        // fetch the base branch before branching (fresh clone: no-op)
  deleteDirectoryOnArchive: boolean // archive also removes the directory from disk
  autoOpenSession: boolean          // open a session right after a successful create
  concurrency: number               // max simultaneous git jobs
}
```

## Methods

Every request below is `payload`; every response is the `value` inside
`{ ok: true, value }`.

| Method | Payload | Value |
| --- | --- | --- |
| `state` | `{}` | `{ repos: Repo[], items: WorkspaceItem[], jobs: Job[], settings: Settings, stores: StoreInfo }` |
| `repos/branches` | `{ url: string }` | `{ branches: string[], head: string \| null }` |
| `repos/save` | `{ repo: Partial<Repo> & { url: string } }` | `{ repo: Repo }` |
| `repos/remove` | `{ id: string }` | `{ removed: boolean }` |
| `workspaces/create` | `CreateRequest` | `{ job: Job }` |
| `workspaces/archive` | `{ id: string, deleteDirectory?: boolean }` | `{ job: Job }` |
| `workspaces/restore` | `{ id: string }` | `{ item: WorkspaceItem }` |
| `workspaces/rename` | `{ id: string, name?: string, title?: string }` | `{ item: WorkspaceItem }` |
| `workspaces/forget` | `{ id: string, deleteDirectory?: boolean }` | `{ job: Job }` |
| `workspaces/observe` | `{ id?: string, path?: string }` | `{ items: WorkspaceItem[] }` |
| `jobs/list` | `{}` | `{ jobs: Job[] }` |
| `jobs/cancel` | `{ id: string }` | `{ cancelled: boolean }` |
| `settings/set` | `{ patch: Partial<Settings> }` | `{ settings: Settings }` |
| `fs/reveal` | `{ path: string }` | `{ revealed: boolean }` |

### `CreateRequest`

```ts
interface CreateRequest {
  repoId?: string          // an existing Repo; when omitted, url/baseBranch/parentDir must be present
  url?: string             // ad-hoc remote, saved as nothing
  baseBranch?: string
  parentDir?: string
  name: string             // user-given short name, e.g. "retry-fix"
  branch?: string          // explicit branch name; '' means "derive from branchPrefix + name"
  directoryName?: string   // explicit folder name; '' means "derive from directoryTemplate"
  title?: string           // DSH workspace title; '' means "use name"
  fetch?: boolean          // override settings.fetchBeforeCreate
}
```

`workspaces/create` answers immediately with the created `Job`; the clone,
branch, and registration continue in the background.

### `StoreInfo`

```ts
interface StoreInfo {
  file: string           // absolute path of the JSON store
  writeError: string | null
  gitPath: string | null
  gitVersion: string | null
}
```

## Host core surface (the test seam)

`src/host.js` exports the whole Host domain as a plain object so a spec can drive
it with fakes and no cordis. This surface is frozen too.

```js
/**
 * @param {object} options
 * @param {() => object | undefined} [options.getSubprocess]
 * @param {() => object | undefined} [options.getWorkspaceRegistry]
 * @param {{ warn?: Function, info?: Function, error?: Function }} [options.logger]
 * @param {object} [options.config]   the normalized config (see cordis.patch.yml)
 * @param {object} [options.store]    override the JSON store; when omitted one is
 *                                    created from `config.storageFile`
 * @returns {object} the core
 */
export function createWorkspaceManagerCore(options)
```

The returned core has exactly these members:

| Member | Contract |
| --- | --- |
| `dispatch(method, payload)` | **The single entry point.** `method` is one of the PROTOCOL.md methods; `payload` is the request object (missing → `{}`). Resolves with the `value` documented for that method. Rejects with an `Error` carrying `code` (from the error table), `message`, and `details`. The HTTP route is a thin wrapper over this and adds nothing but the envelope. |
| `start()` | Load the store from disk. Idempotent. Resolves once ready. |
| `close()` | Stop accepting new jobs, terminate running git children, flush the store. Idempotent. |
| `onChange(listener)` | Subscribe to a snapshot change; returns the unsubscribe function. Used by `apply` for logging only. |

Consequences a spec may rely on:

- Two cores built over the same `config.storageFile` see each other's writes; the
  second `start()` reads what the first persisted.
- `dispatch` may be called before `start()`; it awaits readiness internally.
- A fake `getSubprocess()`/`getWorkspaceRegistry()` returning `undefined` makes
  exactly the documented capability-absent codes appear — nothing else changes.

## Error codes

`code` is a stable discriminant; `message` is the localized human text.

| Code | Meaning |
| --- | --- |
| `workspace-manager/unknown-method` | The endpoint is not in the table above. |
| `workspace-manager/bad-request` | Payload failed validation. |
| `workspace-manager/no-git` | `git` was not resolvable in this Host's execution world. |
| `workspace-manager/git-failed` | A git command exited non-zero; `details.stderr` carries the tail. |
| `workspace-manager/busy` | The concurrency limit is reached. |
| `workspace-manager/not-found` | The addressed `Repo`/`WorkspaceItem`/`Job` does not exist. |
| `workspace-manager/path-exists` | The target directory already exists and is not empty. |
| `workspace-manager/registry-unavailable` | `workspaceRegistry` is absent, so the DSH workspace list cannot be changed. |
| `workspace-manager/registry-failed` | `workspaceRegistry.create/delete` rejected. |
| `workspace-manager/storage-failed` | The JSON store could not be read or written. |
| `workspace-manager/unsupported` | The operation needs a capability this Host does not compose. |

## Host-side capability use

The Host half never imports another plugin's module. It reaches everything
through `ctx.get`:

| Capability | Use | Absent behaviour |
| --- | --- | --- |
| `webServer` | the `POST /workspace-manager/*` route | hard `inject`; the plugin does not mount |
| `connection` | `admit(req)` trust check | hard `inject`; the plugin does not mount |
| `subprocess` | `resolveExecutable('git')` and `spawn` for every git command | `no-git` on git methods; the panel still loads and reports it |
| `workspaceRegistry` | `create(path, title)`, `delete(id)`, `get(id)`, `list()` | `registry-unavailable` |

## Browser-side capability use

The browser half declares `inject: ['slots', 'connection', 'layout']` and
reaches optional Client services through `ctx.get`:

| Capability | Use | Absent behaviour |
| --- | --- | --- |
| `uiWorkspace.startSession(workspaceId)` | select the workspace and open a fresh session | the button reports that navigation is unavailable |
| `uiWorkspace.openWorkspace(workspaceId)` | open the workspace's blank session without forcing a new one | same |
| `uiWorkspace.pickDirectory()` | choose a parent directory for clones | the field stays free-text |
| `uiWorkspace.listDirectory(path)` | browse a directory level | same |
| `workspaces.rename(workspaceId, title)` | keep the DSH title in step with our record | local record only |
| `layout.selectPanel('workspaceManager')` | bring the panel forward | hard `inject` |

## Slot surface

| Slot | Registration | Component |
| --- | --- | --- |
| `main` | keyed `workspaceManager` | the panel page |
| `sidebar.panellist` | id `workspaceManager`, order `45` | the sidebar glyph |
