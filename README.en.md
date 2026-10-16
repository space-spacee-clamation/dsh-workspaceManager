# dsh-workspace-manager

[中文](README.md) | English

## What it is for

When you want to push several directions on one project at the same time without
editing them all in one checkout, the manual loop is:

1. make a new folder;
2. `git clone` the repository into it;
3. add that folder to DSH as a workspace;
4. cut a new branch;
5. open another session.

None of those steps is hard, and all of them are repeated busywork — folder
name, branch name, parent directory, every single time.

This plugin collapses the whole loop into one DSH panel: **register a
repository, type a name, click once.** The clone, the branch, the workspace
registration, and the session all happen automatically. When you are done,
archiving the workspace takes it off the DSH workspace list while leaving the
directory on disk.

## Install

The plugin installs as a DSH bundle. **No restart is required** — the launcher's
own `watchUserPatches` hot-mounts the new patch row.

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add github:space-spacee-clamation/dsh-workspaceManager
```

Then append this block to that profile's `cordis.patch.yml` (replace a lone `[]`
with these two blocks):

```yaml
- insert:
    - id: workspace-manager
      name: dsh-workspace-manager
```

The patch layer reloads live; refresh the browser tab and the
**Concurrent Workspaces** entry appears in the panel list.

For local development, `tools/install.mjs` does the same three things by hand —
a junction in the profile's `node_modules`, the `dependencies` entry, and the
`insert` rows in the profile's `cordis.patch.yml` inside a marked block — and
backs up every file it rewrites:

```powershell
node tools/install.mjs --dry-run    # show what would change
node tools/install.mjs              # apply
node tools/install.mjs --uninstall  # reverse it by marker
```

## Using it

The panel has three sections.

### 1. Repositories

Fill this in once per repository:

- **Repository URL** — anything `git clone` accepts: `https://…`, `git@…`, or a
  local path.
- **Display name** — how the panel refers to it; also feeds the directory-name
  template.
- **Default development branch** — the 分支 button runs `git ls-remote` and lets
  you pick from the real remote branches, or you can type one.
- **Clone parent directory** — where this repository's clones go.

### 2. New sub-workspace

- **Repository** — a saved one, or 临时仓库 to type an ad-hoc URL.
- **Name** — what this line of work is called, e.g. `retry-fix`. It becomes the
  workspace title and part of the directory name.
- **Branch** — prefilled from the name until you edit it yourself.
- **Directory name / parent** — the clone lands at `<parent>/<directory name>`.
- **Base branch** — read-only, shows what the new branch is cut from.

**创建并注册工作区** starts the job. A strip under the panel shows live
`git clone` / `git fetch` / `git checkout -b` / registry progress with a log, and
can cancel it.

### 3. Sub-workspaces

One card per sub-workspace:

| Action | Effect |
| --- | --- |
| **Open session** | Selects the workspace and creates a **fresh session**, revealing the conversation. |
| **Reuse blank session** | Opens that workspace's blank session, reusing an existing one when there is one. |
| **Rename** | Renames the workspace title and syncs it to the DSH workspace list. |
| **Reveal in file manager** | Opens the clone directory in the OS file manager. |
| **Archive** | Removes the workspace from the DSH workspace list. A confirm dialog offers **also delete the local directory**, off by default — archiving should be safe, deleting a folder is a separate intent. |

Archived cards collapse into an **Archived** section, where they can be restored
to the workspace list or forgotten entirely.

## Where the records live

```
$DSH_HOME/storages/dsh-workspace-manager.json
```

One JSON file, written atomically (temp file + rename). A malformed file is
backed up to `<file>.bak-<timestamp>` and rebuilt rather than thrown away.

It stores three things only: your registered repositories, the sub-workspace
records, and the global settings. **Branch and directory state is always read
live from disk and git**, so a stale record can never show you the wrong branch.

## Configuration

Every key in the patch row's `config` is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultParentDir` | `''` | Default clone parent; empty means `$DSH_HOME/workspaces`. |
| `directoryTemplate` | `'{repo}-{name}'` | Directory-name template; `{repo}`, `{name}`, `{branch}`. |
| `branchPrefix` | `''` | Prefix for an auto-derived branch name. |
| `cloneDepth` | `0` | `0` = full clone; a positive number adds `--depth`. |
| `partialClone` | `false` | Adds `--filter=blob:none` (ignored when `cloneDepth > 0`). |
| `fetchBeforeCreate` | `true` | `git fetch origin <base>` before cutting the branch. |
| `deleteDirectoryOnArchive` | `false` | Default state of the archive dialog's delete checkbox. |
| `autoOpenSession` | `false` | Open a session automatically after a successful create. |
| `concurrency` | `2` | Maximum simultaneous git jobs. |
| `storageFile` | `''` | Override the storage file path. |

## How it plugs into DSH

One Loader row registers both halves:

- **Host half** (`lib/index.js`) registers `POST /workspace-manager/<method>` on
  `ctx.webServer`, runs git through `ctx.get('subprocess')`, adds and removes DSH
  workspace registrations through `ctx.get('workspaceRegistry')`, and owns the
  JSON store.
- **Browser half** (`lib/client.js`) registers `sidebar.panellist` (the sidebar
  glyph) and `main` keyed `workspaceManager` (the panel page), and drives
  `ctx.get('uiWorkspace').startSession(workspaceId)` for the open-session action.

`subprocess` and `workspaceRegistry` are **optional** and read with `ctx.get()`.
A host without them still loads the plugin: the panel reports "git was not
found" or "the workspace registry is unavailable" instead of failing the mount.

The complete wire contract is [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

```powershell
node tools/build.mjs          # build lib/ (host copied verbatim, browser wrapped into __ModuleLoader__)
node tools/build.mjs --check  # verify lib/ matches src/
node --test "tests/*.test.mjs"
```

Rebuild after every `src/` change — DSH serves `lib/client.js`, not the source.

## Known limitations

- **Large clones take time.** The job strip shows progress and can be cancelled,
  but cancelling does **not** delete the partially cloned directory: the plugin
  never silently removes your files.
- **No `git worktree`.** The plugin deliberately uses independent clones, because
  a DSH workspace is identified by its own canonical directory and worktrees
  sharing one `.git` complicate that.
- **No conflict resolution.** If the target branch already exists the job fails
  and shows git's own error; it never renames or force-pushes on your behalf.
- **Archive only, no merge.** The plugin opens branches and retires workspaces;
  it does not do pull requests, merges, or remote branch deletion.
- **Panel copy is Chinese-only** for now.

## License

MIT
