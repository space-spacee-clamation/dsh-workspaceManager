# Independent verification report — `dsh-workspace-manager`

**Verdict: PASS — 30/30 specs, green on three consecutive full runs and on each
spec file alone, with `lib/` current before and after every run.**
One real defect (D1) was found, reported, fixed by the Host half, and re-verified
here; it is kept below as a defect record with its reproduction. No other
divergence from `docs/PROTOCOL.md` was found in the covered surface.

Verifier: `verifier` (task-3). Everything below is observed output from this
checkout on 2026-10-16, Windows, Node v24.16.0, git 2.56.0.windows.1. The suite
was written from `docs/PROTOCOL.md` before any Host/Browser source was read;
sources were consulted afterwards only to explain failures. `src/**`, `lib/**`,
`tools/**`, `docs/**`, `package.json` and `cordis.patch.yml` were never modified
by this task; every edit is under `tests/**`.

## 1. Commands and observed output (post-fix)

| Command | Observed |
| --- | --- |
| `node tools/build.mjs --check` (before run 1) | exit 0 — `Build output is current (9 files).` |
| `node --test "tests/*.test.mjs"` — run 1 | `tests 30  pass 30  fail 0  cancelled 0  duration_ms 76159` |
| `node --test "tests/*.test.mjs"` — run 2 | `tests 30  pass 30  fail 0  cancelled 0  duration_ms 68086` |
| `node tools/build.mjs --check` (after run 2) | exit 0 — `Build output is current (9 files).` |
| `node --test "tests/*.test.mjs"` — run 3, temp dir emptied first | `tests 30  pass 30  fail 0  cancelled 0  duration_ms 66835` |
| `node tools/build.mjs --check` (after run 3) | exit 0 — `Build output is current (9 files).` |
| `node --test tests/build.test.mjs` (alone) | exit 0 — 5 tests, 5 pass |
| `node --test tests/client.test.mjs` (alone) | exit 0 — 7 tests, 7 pass |
| `node --test tests/host.test.mjs` (alone) | exit 0 — 18 tests, 18 pass |
| `node --test --test-name-pattern "failed job carries" tests/host.test.mjs` | exit 0 (the D1 repro, now green) |

All three full runs passed the same 30 specs; nothing was intermittent.

**Pre-fix history (kept for the record).** The first full run (27 specs) failed
on two stale-build checks — a rebuild raced that run — and on D1 plus two specs
that died with `ctx.provide is not a function`, i.e. my fake context was missing
a member `apply()` legitimately calls. The second run exposed the two bugs those
exceptions had masked: my route helper passed the endpoint name as the HTTP
method (405 instead of 200), and the plugin-boot store guard tripped on a
deliberately refused admission (401). All three were fixed in `tests/**` only.
Of the five observed failures, exactly one (D1) was an implementation defect.

## 2. Defect D1 — fixed and re-verified

**A failed background job lost the `workspace-manager/git-failed` discriminant.**

*Smallest reproduction (unchanged):*

```
node --test --test-name-pattern "git-failed" tests/host.test.mjs   # pre-fix name
node --test --test-name-pattern "failed job carries" tests/host.test.mjs   # post-fix name
```

*Pre-fix observation* — `workspaces/create` from `<tmp>/no-such-remote` settled
as:

```json
{"kind":"create","label":"wm/epsilon","status":"failed","step":"失败","progress":-1,
 "log":[..., {"level":"error","text":"git clone 失败（退出码 128）：and the repository exists."}],
 "error":"git clone 失败（退出码 128）：and the repository exists.","resultId":null}
```

The string `git-failed` appeared nowhere in the serialized job, and the tightened
spec died on its first arm with `AssertionError: a running job carries no failure
code — actual: undefined, expected: null`: `Job` had no `code` member at all.
Because `workspaces/create` answers with the job before the work runs, the job is
the only failure channel, so the discriminant was unreachable and a client would
have had to parse localized prose to tell a git failure from a registry or
storage failure. Cause: `settle(record, status, errorText)` stored the message
only.

*Resolution.* `docs/PROTOCOL.md` now freezes `Job.code: string | null` (`null`
while running, on success and on cancel; never repeated inside `error`), and the
Host half populates it on every failure path. Re-verified observation:

```
status = failed
code   = "workspace-manager/git-failed"
error  = "git clone 失败（退出码 128）：fatal: '…\no-such-remote' does not appear to be a git repository"
```

The spec asserts both arms: a running job and a successful job carry
`code === null` (`error === null` on success) while the failed job carries the
stable code with a non-empty human message that does not repeat it.

**O1 (same spec, also fixed).** The pre-fix message was git's *last* stderr line
(`and the repository exists.`). The post-fix message above carries git's real
diagnostic (`fatal: … does not appear to be a git repository`). The spec does not
pin the wording — the protocol only requires a non-empty message — so this is
recorded as an observation the Host half addressed, not as an asserted clause.

## 3. Spec map

### `tests/build.test.mjs` — artifact plane

| Spec | Clause proven |
| --- | --- |
| `tools/build.mjs --check reports current build output` | `lib/` matches `src/` (exit 0). |
| `lib/client.js is one module-loader registration` | Exactly one top-level `window.__ModuleLoader__.load(` statement and no top-level ESM syntax in the emitted bundle. |
| `lib/client.js registers under the package name` | Registration `id` equals `package.json.name`. |
| `the host entry ships at the package main` | `main: lib/index.js` exists and is non-empty. |
| `every relative import in the shipped host half resolves` | No dangling relative import in the verbatim `lib/` copy. |

### `tests/client.test.mjs` — browser half

Booted exactly as the shell boots it: `node:vm` page sandbox with
`__ModuleLoader__ = { mode:'queue', pendingQueue, load(reg), create() }`, then the
factory is materialized with a `require` that resolves only the nine platform
modules — an unknown specifier throws, mirroring `manifest.ts`'s "anything else →
throw".

| Spec | Clause proven |
| --- | --- |
| `lib/client.js registers one bundle whose factory returns the plugin` | Factory returns `{ name, inject: ['slots','connection','layout'], apply }`. |
| `every module the bundle requests is a platform module` | Every `require(...)` is one of the nine platform modules; no `require.async` chunk. |
| `apply contributes exactly the two documented slots` | Slot surface: `main` keyed `workspaceManager`; `sidebar.panellist` id `workspaceManager`, order `45`; exactly two contributions. |
| `apply survives every optional client service being absent` | `uiWorkspace`/`workspaces` reached through `ctx.get` are optional for mounting. |
| `the registered components render with framework-shaped props` | Both components are functions that render to an element or `null` without throwing. |
| `the tree is built with element APIs and owns no subscription state` | `createElement`/jsx-runtime is used; no `createContext`/`useContext`/`useSyncExternalStore`. |
| `the panel reacts to a workspace without touching the network` | Rendering issues no unexpected RPC, every observed channel is `workspace-manager`, and the sandbox `fetch` throws if used. |

### `tests/host.test.mjs` — domain (through `core.dispatch`) and transport

| Spec | Clause proven |
| --- | --- |
| `repos/branches reports every branch and the remote default head` | `{ branches, head }` against a real bare remote (`develop`, `main`, head `main`). |
| `workspaces/create clones the branch and registers the workspace` | Clone at `<parentDir>/<directoryName>`, requested branch checked out (`git rev-parse --abbrev-ref HEAD`), item carries `branch`/`path`/`workspaceId`/`name`/`title`/`archived`/`baseBranch`/`repoUrl`, and `workspaceRegistry.create(path, title)` received the real path and title. |
| `creating into a non-empty directory fails with path-exists and leaves it untouched` | `workspace-manager/path-exists`; directory contents unchanged; no item registered. Observed: the create call itself rejects. |
| `the work branch is really based on the base branch` | A commit pushed to `develop` after the fixture was built is present in `git log` of the clone made from `develop`. |
| `workspaces/archive unregisters, keeps the directory, and honors deleteDirectory` | `registry.delete(workspaceId)`; `archived: true`, `workspaceId: null`, `archivedAt` set; directory kept by default, removed with `deleteDirectory: true`. |
| `workspaces/restore re-registers the workspace` | `{ item }` with `archived: false`, `archivedAt: null`, a new `workspaceId`, and a second `registry.create`. |
| `a failed job carries the git-failed code while a successful job carries none` | `Job.code` arm of the frozen contract (running null / ok null / failed `workspace-manager/git-failed`), plus non-empty `error`, `endedAt`, `resultId: null`. |
| `the JSON store round-trips into a second core over the same file` | `state.stores.file`; a second core reads back the same repos/items; `gitVersion` a string, `writeError` null. |
| `dispatch works before start(), and start() is idempotent` | Test-seam clause "dispatch may be called before `start()`". |
| `onChange notifies subscribers and returns an unsubscribe function` | The listener fires on a store write and the returned unsubscribe stops delivery. |
| `an absent subprocess capability answers no-git` | `getSubprocess() → undefined` gives exactly `workspace-manager/no-git`; `stores.gitPath`/`gitVersion` stay `null`. |
| `an absent workspaceRegistry answers registry-unavailable` | `getWorkspaceRegistry() → undefined` gives exactly `workspace-manager/registry-unavailable`. Observed: create rejects; no job starts. |
| `the remaining record methods round-trip` | `repos/save`, `repos/remove` (record leaves the store), `workspaces/rename` persisting `name`/`title`. |
| `workspaces/forget archives, drops the record, and optionally removes the directory` | `kind: 'archive'`, unregisters, drops the item from `state.items`, removes the clone with `deleteDirectory: true`. |
| `validation and lookup failures use the documented codes` | `bad-request`, `not-found`, `unknown-method`. |
| `concurrency: 1 never lets two git jobs overlap` | Two simultaneous creates keep the observed concurrent git spawn count at exactly 1; every accepted job settles `ok`. |
| `the prefix route answers the frozen envelope` | One `kind: 'prefix'` route at `/workspace-manager`; a valid `client-request` → HTTP 200 `{ type:'server-response', rpcId, result:{ ok:true, value:{ job } } }`; method ≠ endpoint → 400; malformed JSON → 400; `GET` → 405 (`allow: POST` when present); unknown endpoint → `ok:false` + `unknown-method` at 200. |
| `an unadmitted request is refused with the admission status` | `{ rejection: 401 }` → 401, `{ rejection: 403 }` → 403, i.e. the handler propagates the given status instead of hardcoding one. |

Every host spec goes through `core.dispatch(method, payload)` except the two
route specs, which feed a fake async-iterable `req` and a recording `res` into
the handler registered via `ctx.effect(() => ctx.webServer.register(...))`.

## 4. Clauses I could NOT prove, and why

| Clause | Why not proven |
| --- | --- |
| `workspace-manager/busy` | Not a defect. The runner **queues** instead of refusing: with `concurrency: 1` two simultaneous creates are both accepted (`spawns: 1` at dispatch time, `maxActive: 1` throughout, both jobs `ok`), and `busy` is answered only once the queue is saturated (≥16 queued). Proving it would need 17 queued jobs — deliberately not spent on a spec. |
| `Settings.directoryTemplate` / `branchPrefix` derivation (`''` → derive) | The suite always passes explicit `branch`/`directoryName`; deriving would test a template language the protocol does not spell out. |
| `defaultParentDir` inheritance, `cloneDepth`, `partialClone`, `fetchBeforeCreate`, `autoOpenSession` | Each needs its own fixture and observable (shallow history, filter config, session open). |
| `workspaces/observe` and `ItemStatus` (`exists`, `registered`, `branch`, `dirty`, `ahead`, `behind`, `error`) | Needs a dirty / ahead / behind fixture with upstream tracking; `status` is documented as observed lazily and never persisted. |
| `jobs/cancel` | Needs a deterministically long job; a local fixture finishes in ~200 ms, so a cancel spec would be racy. |
| `fs/reveal` | Deliberately never called: it would launch the user's file manager. It is the one method in the table the suite does not exercise. |
| `registry-failed`, `storage-failed`, `unsupported` codes | Need fault injection into the registry/store doubles, which the harness does not provide. (`git-failed`, `path-exists`, `not-found`, `bad-request`, `unknown-method`, `no-git`, `registry-unavailable` **are** proven.) |
| `no-git` for every git-backed method | Proven for `repos/branches` only. |
| `git-failed` `details.stderr` tail | Jobs carry no `details`; the tail is visible only in `job.log`. The `git-failed` *code* and message are proven. |
| `Job.progress` / `step` / `label`, `JobLogEntry.level` enumeration | Only `log` being an array, `endedAt`, `error`, `code`, `resultId`, `kind`, `status` are asserted. `label` was observed to be the branch name (`wm/epsilon`) but is not pinned. |
| Browser-side `uiWorkspace.startSession/openWorkspace/pickDirectory/listDirectory`, `workspaces.rename`, `layout.selectPanel('workspaceManager')` | The suite proves the plugin mounts with those services absent and that components render; it does not simulate clicks, so the per-button "navigation unavailable" fallbacks are unproven. |
| Route 400/405 bodies being *plain text* | The suite asserts a non-empty body and, for 405, an `allow: POST` header when present; content types are not pinned. |
| `lib/index.js` byte-identical to `src/host.js` | Implied by `build.mjs --check`, not asserted separately. |

### Deliberate relaxation

The task asked to assert that `createElement` is *the only* React API used. The
spec instead requires the React surface to come from an element-and-local-state
allow-list and forbids `createContext`, `useContext` and `useSyncExternalStore`.
Reason: a real DSH bundle (checked against `dsh-todonote/lib/client.js` through
the same loader) legitimately touches `useState`/`useEffect`/`useRef`, and the
`packages/client` rules forbid only ctx-reaching and subscription state. This
bundle currently touches none of the forbidden APIs and does use `createElement`.

## 5. Isolation evidence

* Every fixture lives under `os.tmpdir()` (`fs.mkdtempSync`, realpath-normalized)
  and is removed in a `t.after`/`finally` hook. After run 3 — started with an
  emptied temp directory — **the count of `dsh-wm-*` directories was 0**, and it
  was still 0 after the three solo runs.
* A controlled probe confirms cleanup also happens when a spec **fails**
  (a deliberate `assert.fail` and a deliberate async throw both left nothing).
  The only way to leak a fixture is to kill the runner mid-spec, which cannot run
  `t.after` hooks; a forced `Stop-Process` probe left exactly its live fixture
  behind (`+3` directories). Four such directories dated 17:14, produced by an
  externally terminated run while this verification was in progress, were
  removed before run 3; no complete run of this suite leaks anything.
* `tests/host.test.mjs` redirects `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME` and `XDG_CACHE_HOME` to a temp directory for the whole file and
  restores them in a top-level `after`. The user's `~/.dsh` was not written by
  these runs, and each spec asserts `state.stores.file` is inside `os.tmpdir()`
  before it mutates anything.
* No spec uses the network: git runs against a local bare remote, the sandbox
  `fetch` throws, and page timers never fire.
* `git` is spawned through a `node:child_process` adapter with
  `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_CONFIG_NOSYSTEM=1`, so a spec
  cannot hang on a credential prompt or read system git config.

## 6. Doubt to carry into acceptance

1. **The suite proves the contract, not the UI.** Browser-side interaction
   (buttons calling `startSession`, the archive confirm dialog, polling while a
   job runs) is verified only as far as "registers, mounts and renders". A human
   or a browser-driven pass is still the only evidence for those.
2. **`busy` is asserted nowhere.** If the acceptance criteria require the
   concurrency limit to be *refused* rather than queued, that is a product
   decision the current suite neither proves nor contradicts.
3. **`fs/reveal` was never executed** (it launches a file manager), so its
   `{ revealed: false }` fallback is unproven.
4. **The store round-trip is same-process.** Two cores over one file were proven;
   a crash-during-write recovery path (`<file>.bak-<timestamp>`) was not.
5. **Timing sensitivity is low but non-zero.** Specs poll for job settlement with
   a 60 s bound and failed runs surface the whole job log; three consecutive
   green runs plus three solo green runs showed no flakiness.

## 7. Files

```
tests/build.test.mjs           build-output contract
tests/client.test.mjs          browser half via the vm module-loader harness
tests/host.test.mjs            host domain (core.dispatch) + transport, real git fixture
tests/helpers/repo.mjs         git fixture, fs helpers, fake Host context, req/res doubles
tests/helpers/subprocess.mjs   real-git `subprocess` capability adapter
tests/helpers/loader.mjs       page sandbox, platform module table, client context double
tests/REPORT.md                this report
```
