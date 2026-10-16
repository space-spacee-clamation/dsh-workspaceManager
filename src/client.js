/**
 * dsh-workspace-manager — browser half (source).
 *
 * This file is NOT a module: tools/build.mjs wraps it in the module-loader
 * registration closure the DSH client module system serves, exactly like a
 * shipped `lib/client.js`. It may use only the platform modules the shell seeds
 * (react, react-dom, @deepseek-ai/dsh-client-ui-primitives, …), and it must
 * define `createWorkspaceManagerPlugin(require)`.
 *
 * Every Host call goes through the envelope frozen in docs/PROTOCOL.md:
 * `POST <origin>/workspace-manager/<method>` with
 * `{ type: 'client-request', rpcId, method, payload }` and a
 * `{ type: 'server-response', rpcId, result }` answer. `connection.rpc.call`
 * issues exactly that request and owns rpcId correlation, so the caller below
 * uses it and keeps a plain-fetch fallback for a client without it.
 *
 * Surfaces registered here:
 *   - `main` (keyed by PANEL_ID) — the 并发工作区 page
 *   - `sidebar.panellist`        — that page's sidebar glyph
 */

function createWorkspaceManagerPlugin(require) {
  const React = require('react')
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  const h = React.createElement

  const {
    Button,
    Input,
    Modal,
    Tag,
    StateDot,
    SegmentedTabs,
    Checkbox,
    IconWorkspaceTreeOutlineRegular,
    IconPlusOutlineRegular,
    IconRefreshOutlineRegular,
    IconArchiveOutlineRegular,
    IconArchiveOffOutlineRegular,
    IconPlayOutlineRegular,
    IconTrashOutlineRegular,
    IconEditOutlineRegular,
    IconBranchOutlineRegular,
    IconFolderOpenOutlineRegular,
    IconBrowseOutlineRegular,
    IconWarningOutlineRegular,
  } = primitives

  /** Sidebar row id and the keyed `main` dispatch key — the SAME string in both. */
  const PANEL_ID = 'workspaceManager'
  /** Absolute Connection channel whose prefix route the Host half registers. */
  const RPC_CHANNEL = '/workspace-manager'
  /** How often a running job is polled, in milliseconds. */
  const POLL_MS = 1500
  /** How long a transient notice stays on screen, in milliseconds. */
  const NOTICE_MS = 4600
  /** How many job log lines the strip shows. */
  const JOB_LOG_LINES = 6

  /** All user-visible copy lives here. */
  const T = {
    panel: '并发工作区',
    title: '并发工作区',
    subtitle: '登记仓库、克隆出新目录、拉出独立分支并注册进工作区列表；用完归档即可移出列表',
    refresh: '刷新',
    loading: '加载中…',
    close: '关闭',
    cancel: '取消',
    save: '保存',
    dismiss: '知道了',
    unknown: '未知错误',
    badReply: '连接返回了无法识别的内容',
    transportFailed: '请求失败：HTTP ',
    storageDown: '存储不可用，这里的改动不会被保存：',
    gitMissing: '没有找到 git，克隆和分支操作都会失败：请先安装 git 并确认它在 PATH 里。',
    gitFound: 'git：',
    storeFile: '存储文件：',
    repos: '仓库',
    reposHint: '一条记录记住「克隆到哪里、从哪个分支开发」，同一个仓库可以反复派生新的子工作区。',
    addRepo: '添加仓库',
    editRepo: '编辑',
    saveRepo: '保存仓库',
    removeRepo: '删除',
    removeRepoAgain: '再点一次删除',
    repoUrl: '仓库地址',
    repoUrlPlaceholder: 'git@github.com:org/repo.git 或 https://…/repo.git',
    repoName: '显示名称',
    repoNamePlaceholder: '例如 my-service，留空则用地址推断',
    baseBranch: '默认开发分支',
    baseBranchPlaceholder: '例如 main',
    baseBranchHint: '读取远端分支后可以直接选，也可以手写。',
    loadBranches: '读取分支',
    loadingBranches: '读取中…',
    customBranch: '手动输入…',
    branchesFailed: '读取分支失败：',
    branchesHead: '远端默认分支：',
    needRepoUrl: '先填仓库地址',
    repoSaved: '仓库已保存',
    repoRemoved: '仓库已删除',
    parentDir: '克隆父目录',
    parentDirPlaceholder: '留空则用设置里的默认目录',
    pickDir: '选择目录',
    pickFailed: '选择目录失败：',
    noPicker: '当前客户端没有目录选择能力，直接填路径即可。',
    emptyRepos: '还没有登记的仓库。填一条「仓库地址」就能开始。',
    createTitle: '新建子工作区',
    createHint: '把这个仓库克隆到一个新目录，切出独立分支，然后注册进 DSH 工作区列表。',
    pickRepo: '仓库',
    adhocRepo: '临时仓库（不保存）',
    name: '名称',
    namePlaceholder: '例如 retry-fix',
    nameHint: '这个名字就是新工作区的名字，也会进入分支名和目录名。',
    branch: '分支名',
    branchPlaceholder: '例如 ws/retry-fix',
    branchHint: '默认用「分支前缀 + 名称」；自己改过之后就不再自动跟随。',
    directoryName: '目录名',
    directoryHint: '默认按设置里的目录模板生成；自己改过之后就不再自动跟随。',
    fromBranch: '从分支',
    fromBranchUnknown: '先选仓库或填写分支',
    create: '创建并注册工作区',
    creating: '创建中…',
    needName: '先给这个子工作区起个名字',
    needUrl: '临时仓库需要填仓库地址',
    needBaseBranch: '临时仓库需要填从哪个分支派生',
    createQueued: '已开始创建：',
    items: '子工作区',
    itemsHint: '每张卡片对应一个克隆出来的目录，以及它注册进 DSH 的工作区。',
    viewLabel: '子工作区视图',
    viewAll: '全部',
    viewActive: '进行中',
    viewArchived: '已归档',
    groupActive: '进行中',
    groupArchived: '已归档',
    emptyItems: '还没有子工作区。在上面填好名称，点「创建并注册工作区」。',
    emptyArchived: '还没有归档的子工作区。归档后的记录会留在这里。',
    openSession: '打开会话',
    reuseSession: '复用空白会话',
    rename: '重命名',
    reveal: '在文件夹中打开',
    archive: '归档',
    restore: '恢复到工作区列表',
    forget: '彻底删除记录',
    workspaceId: '工作区 ID：',
    notRegistered: '这条记录还没有注册进 DSH 工作区列表，无法打开会话。',
    noNavigation: '当前客户端没有工作区导航能力，无法打开会话。',
    opened: '已在该工作区打开一个新会话',
    reused: '已打开该工作区的空白会话',
    openFailed: '打开会话失败：',
    revealed: '已用文件管理器打开：',
    revealFailed: '打开文件夹失败：',
    exists: '目录存在',
    missing: '目录不存在',
    registered: '已注册',
    unregistered: '未注册',
    clean: '干净',
    dirty: '有改动',
    ahead: '领先 ',
    behind: '落后 ',
    observeError: '状态读取失败：',
    archivedAt: '归档于 ',
    adhoc: '临时仓库',
    archiveTitle: '归档子工作区',
    archiveBody: '归档会把它从 DSH 工作区列表移除；本地目录默认保留。',
    forgetTitle: '彻底删除记录',
    forgetBody: '这条记录会从管理器里消失，之后无法恢复。',
    deleteDirectory: '同时删除本地目录',
    deleteDirectoryWarn: '本地目录里未提交的改动会一起消失。',
    archivedDone: '已归档并移出工作区列表',
    archivedWithDelete: '已归档，本地目录也删除了',
    forgotten: '记录已彻底删除',
    restored: '已恢复到工作区列表',
    renamed: '已更新名称',
    renameTitle: '重命名子工作区',
    renameTitleField: '会话标题',
    renameTitleHint: '留空则沿用名称。',
    jobs: '任务',
    jobRunning: '进行中',
    jobOk: '已完成',
    jobFailed: '失败',
    jobCancelled: '已取消',
    jobLog: '日志',
    cancelJob: '取消任务',
    cancelRequested: '已请求取消',
    cancelFailed: '取消失败',
    settings: '设置',
    settingsHint: '这些默认值保存在 Host 的 JSON 存储里，对所有子工作区生效。',
    settingsParentDir: '默认克隆父目录',
    settingsTemplate: '目录名模板',
    settingsTemplateHint: '{repo} = 仓库名，{name} = 子工作区名，{branch} = 分支名。',
    settingsPrefix: '分支名前缀',
    settingsPrefixHint: '没有自己写分支名时，用「前缀 + 名称」。',
    settingsDepth: '克隆深度',
    settingsDepthHint: '0 = 完整历史；正数会给 clone 加 --depth。',
    settingsPartial: '部分克隆（--filter=blob:none）',
    settingsFetch: '创建前先 fetch 基分支',
    settingsDelete: '归档时同时删除本地目录',
    settingsAutoOpen: '创建成功后自动打开会话',
    settingsConcurrency: '同时运行的 git 任务数',
    saveSettings: '保存设置',
    settingsSaved: '设置已保存',
  }

  /** One stylesheet for every surface this plugin draws. */
  const CSS = `
.wsm-page{display:flex;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.wsm-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.wsm-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 56px}
.wsm-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:14px}
.wsm-head h1{font-size:20px;line-height:28px;margin:0}
.wsm-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px}
.wsm-head-actions{display:flex;gap:8px;flex-shrink:0}
.wsm-warn{margin-bottom:12px;padding:8px 12px;border-radius:var(--dsw-radius-md,12px);
  background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);font-size:12px}
.wsm-caution{margin-bottom:12px;padding:8px 12px;border-radius:var(--dsw-radius-md,12px);
  background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font-size:12px}
.wsm-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;
  padding:8px 12px;border-radius:var(--dsw-radius-md,12px);border:0.5px solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
.wsm-notice-text{min-width:0;word-break:break-word}
.wsm-section{margin-top:26px}
.wsm-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:10px}
.wsm-section-head h2{font-size:15px;line-height:22px;margin:0;font-weight:600}
.wsm-section-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px}
.wsm-section-tools{display:flex;gap:8px;align-items:center;flex-shrink:0}
.wsm-tabs{width:210px;flex:0 0 auto}
.wsm-card{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  border-radius:var(--dsw-radius-md,12px);padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.wsm-card + .wsm-card{margin-top:8px}
.wsm-card[data-muted='true']{color:var(--dsw-alias-label-secondary)}
.wsm-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.wsm-card-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.wsm-card-title{font-weight:600;word-break:break-word}
.wsm-title-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.wsm-card-actions{display:flex;flex-wrap:wrap;gap:8px;flex-shrink:0;justify-content:flex-end;max-width:52%}
.wsm-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.wsm-meta b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.wsm-path{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}
.wsm-dots{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wsm-dot{display:inline-flex;align-items:center;gap:5px;min-width:0}
.wsm-dot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.wsm-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
.wsm-form-card{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  border-radius:var(--dsw-radius-md,12px);padding:14px;margin-bottom:10px}
.wsm-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.wsm-field[data-wide='true']{grid-column:1 / -1}
.wsm-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wsm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wsm-hint.wsm-danger{color:var(--dsw-alias-state-error-primary)}
.wsm-danger{color:var(--dsw-alias-state-error-primary)}
.wsm-input-row{display:flex;gap:8px;align-items:center;min-width:0}
.wsm-input-row > *:first-child{flex:1;min-width:0}
.wsm-select{width:100%;box-sizing:border-box;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-sm,8px);padding:6px 8px}
.wsm-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.wsm-readonly{font-size:13px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.wsm-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wsm-empty{color:var(--dsw-alias-label-tertiary);padding:14px 0;font-size:13px}
.wsm-details{margin-top:10px}
.wsm-details > summary{cursor:pointer;list-style:none;font-size:13px;color:var(--dsw-alias-label-secondary);padding:6px 0}
.wsm-details > summary::-webkit-details-marker{display:none}
.wsm-details > summary::before{content:'▸ ';color:var(--dsw-alias-label-tertiary)}
.wsm-details[open] > summary::before{content:'▾ '}
.wsm-job{margin-top:8px;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);
  border-radius:var(--dsw-radius-md,12px);padding:10px 12px}
.wsm-job-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;min-width:0}
.wsm-job-title{min-width:0;word-break:break-word}
.wsm-job-title b{font-weight:600;color:var(--dsw-alias-label-primary)}
.wsm-bar{height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;margin:8px 0}
.wsm-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width 200ms ease}
.wsm-bar[data-indeterminate='true'] .wsm-bar-fill{width:35%;animation:wsm-slide 1.2s ease-in-out infinite}
@keyframes wsm-slide{0%{margin-left:-35%}100%{margin-left:100%}}
.wsm-log{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary);word-break:break-all;max-height:120px;overflow:auto}
.wsm-log-error{color:var(--dsw-alias-state-error-primary)}
.wsm-log-warn{color:var(--dsw-alias-state-warn-label)}
.wsm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.wsm-dialog-text{margin:0 0 10px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.wsm-dialog-name{font-weight:600;margin-bottom:10px;word-break:break-word}
.wsm-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;padding-top:6px}
.wsm-footer{margin-top:32px;display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
@media (max-width:720px){
  .wsm-form,.wsm-settings{grid-template-columns:minmax(0,1fr)}
  .wsm-card-head{flex-direction:column}
  .wsm-card-actions{max-width:none;justify-content:flex-start}
}
`

  /** Inject the stylesheet once per page. */
  function injectStyle() {
    const id = 'dsh-workspace-manager-style'
    if (document.getElementById(id) !== null) return
    const node = document.createElement('style')
    node.id = id
    node.textContent = CSS
    document.head.appendChild(node)
  }

  /**
   * One observable source with a stable snapshot identity between changes. The
   * renderer binds it to a `use<Name>` hook, which re-renders on `set` only.
   * @param initial - the first snapshot.
   * @returns `{ getSnapshot, subscribe, set }`.
   */
  function createSnapshotStore(initial) {
    let snapshot = initial
    const listeners = new Set()
    return {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set(patch) {
        const next = { ...snapshot, ...patch }
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A broken render subscriber must not stop the data channel.
          }
        }
      },
    }
  }

  /** @returns a client-minted correlation id for the fallback transport. */
  function mintRpcId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    } catch {
      // A page without WebCrypto still gets a usable id from the fallback below.
    }
    return `wsm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * Transport wrapper over the Host's `/workspace-manager` prefix route. A
   * business failure resolves as `{ ok: false }` and becomes a thrown Error
   * carrying the server's localized message.
   * @param connection - the client Connection service.
   * @returns a callable `(endpoint, payload) => Promise<value>`.
   */
  function createCaller(connection) {
    return async function call(endpoint, payload) {
      const body = payload ?? {}
      const rpc = connection?.rpc
      if (rpc !== undefined && rpc !== null && typeof rpc.call === 'function') {
        const result = await rpc.call(RPC_CHANNEL, endpoint, body)
        if (result?.ok === true) return result.value
        if (result?.ok === false) throw new Error(result.error?.message ?? T.unknown)
        throw new Error(T.badReply)
      }
      // The generic caller owns rpcId correlation; this fallback posts the very
      // same envelope to the very same route for a client without it.
      const rpcId = mintRpcId()
      const response = await fetch(`${RPC_CHANNEL.slice(1)}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: body }),
      })
      if (!response.ok) throw new Error(`${T.transportFailed}${response.status}`)
      const envelope = await response.json()
      if (envelope?.type !== 'server-response' || envelope?.rpcId !== rpcId) throw new Error(T.badReply)
      const result = envelope.result
      if (result?.ok === true) return result.value
      if (result?.ok === false) throw new Error(result.error?.message ?? T.unknown)
      throw new Error(T.badReply)
    }
  }

  /** @param error - an unknown throwable. @returns its human message. */
  function messageOf(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /** @param component - a candidate icon export. @returns the icon element, or undefined. */
  function icon(component, size) {
    return typeof component === 'function' ? h(component, { size: size ?? 16 }) : undefined
  }

  /** @returns the Host setting defaults, used until `state` answers. */
  function defaultSettings() {
    return {
      defaultParentDir: '',
      directoryTemplate: '{repo}-{name}',
      branchPrefix: '',
      cloneDepth: 0,
      partialClone: false,
      fetchBeforeCreate: true,
      deleteDirectoryOnArchive: false,
      autoOpenSession: false,
      concurrency: 2,
    }
  }

  /** @returns the empty 「新建子工作区」 form. */
  function defaultForm() {
    return {
      repoId: '',
      url: '',
      baseBranch: '',
      name: '',
      branch: '',
      branchTouched: false,
      directoryName: '',
      directoryTouched: false,
      parentDir: '',
      title: '',
    }
  }

  /**
   * Expand the Host's directory-name template.
   * @param template - `'{repo}-{name}'` and friends; empty falls back to that.
   * @param repo - the repo display name, or the ad-hoc URL's last segment.
   * @param name - the sub-workspace name.
   * @param branch - the branch name.
   * @returns the folder name to offer, or '' while there is nothing to derive from.
   */
  function directoryNameFor(template, repo, name, branch) {
    if (String(name).trim().length === 0) return ''
    const pattern = typeof template === 'string' && template.trim().length > 0 ? template : '{repo}-{name}'
    const filled = pattern
      .replaceAll('{repo}', String(repo))
      .replaceAll('{name}', String(name).trim())
      .replaceAll('{branch}', String(branch))
    return filled.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
  }

  /**
   * @param repo - a saved repo, or undefined for an ad-hoc URL.
   * @param url - the ad-hoc URL, used when there is no repo.
   * @returns the `{repo}` substitution for the directory template.
   */
  function repoLabelFor(repo, url) {
    if (repo !== undefined && repo !== null && String(repo.name ?? '').length > 0) return String(repo.name)
    const tail = String(url).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    return tail.replace(/\.git$/, '')
  }

  /** @param value - an ISO-8601 stamp. @returns `YYYY-MM-DD HH:mm`, or ''. */
  function timeText(value) {
    const text = String(value ?? '')
    return text.length >= 16 ? `${text.slice(0, 10)} ${text.slice(11, 16)}` : text
  }

  /** @param value - any settings value. @returns a finite integer, or the fallback. */
  function toInt(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  }

  /**
   * Apply-scoped store: the panel page is its only reader, and one handle is
   * created inside `apply` — never at module level.
   * @param call - the RPC caller.
   * @param capabilities - `uiWorkspace()` returns the optional navigation
   * service or null; `openPanel()` brings this page forward.
   * @returns `{ source, actions, dispose }`.
   */
  function createStore(call, capabilities) {
    const source = createSnapshotStore({
      phase: 'loading',
      error: '',
      data: {
        repos: [],
        items: [],
        jobs: [],
        settings: defaultSettings(),
        stores: { file: '', writeError: null, gitPath: null, gitVersion: null },
      },
      busy: {},
      notice: '',
      noticeSeq: 0,
      form: defaultForm(),
      /** The 仓库 add/edit form, or null while it is closed. */
      repoForm: null,
      /** Branch lists by URL: `{ phase, list, head, error }`. */
      branches: {},
      /** `{ kind: 'archive' | 'forget', id, name, deleteDirectory }`, or null. */
      dialog: null,
      /** `{ id, name, title }`, or null while the rename dialog is closed. */
      rename: null,
      settingsDraft: defaultSettings(),
      settingsDirty: false,
      /** 'all' | 'active' | 'archived'. */
      view: 'all',
    })
    let disposed = false
    let pollTimer = null

    /** @param text - the transient message to show. */
    function notice(text) {
      const current = source.getSnapshot()
      source.set({ notice: String(text ?? ''), noticeSeq: current.noticeSeq + 1 })
    }

    /** @param key - the busy flag to raise or clear. @param value - the new flag value. */
    function setBusy(key, value) {
      const busy = { ...source.getSnapshot().busy }
      if (value === true) busy[key] = true
      else delete busy[key]
      source.set({ busy })
    }

    /** @param entry - the branch-list state to publish. @param url - its key. */
    function setBranches(url, entry) {
      const current = source.getSnapshot().branches
      source.set({ branches: { ...current, [url]: entry } })
    }

    /**
     * Run one operation, reporting any failure as a notice instead of letting
     * it escape into React.
     * @param key - the busy flag to hold while running, or null.
     * @param run - the operation.
     */
    async function guard(key, run) {
      if (key !== null) setBusy(key, true)
      try {
        await run()
      } catch (error) {
        notice(messageOf(error))
      } finally {
        if (key !== null) setBusy(key, false)
      }
    }

    /** Pull the whole Host state and re-arm the poll while any job runs. */
    async function refresh() {
      if (disposed) return
      try {
        const value = await call('state', {})
        if (disposed) return
        const current = source.getSnapshot()
        const data = {
          repos: Array.isArray(value?.repos) ? value.repos : [],
          items: Array.isArray(value?.items) ? value.items : [],
          jobs: Array.isArray(value?.jobs) ? value.jobs : [],
          settings: { ...defaultSettings(), ...(value?.settings ?? {}) },
          stores: value?.stores ?? { file: '', writeError: null, gitPath: null, gitVersion: null },
        }
        const patch = { phase: 'ready', error: '', data }
        if (current.settingsDirty !== true) patch.settingsDraft = data.settings
        // The empty parent-directory field follows the Host default until the
        // user types into it.
        if (current.form.parentDir === '' && data.settings.defaultParentDir !== '') {
          patch.form = patchFormInto(current.form, { parentDir: data.settings.defaultParentDir }, data)
        }
        source.set(patch)
        if (data.jobs.some((job) => job?.status === 'running')) schedulePoll()
        else stopPoll()
      } catch (error) {
        if (disposed) return
        source.set({ phase: 'error', error: messageOf(error) })
      }
    }

    /** Poll again while the Host is still running a job. */
    function schedulePoll() {
      if (disposed || pollTimer !== null) return
      pollTimer = setTimeout(() => {
        pollTimer = null
        void refresh()
      }, POLL_MS)
    }

    /** Stop a poll that no running job needs any more. */
    function stopPoll() {
      if (pollTimer === null) return
      clearTimeout(pollTimer)
      pollTimer = null
    }

    /**
     * Merge a patch into one of the two forms and re-derive the values that
     * follow from it.
     * @param form - the form to start from.
     * @param patch - the fields the user just changed.
     * @param data - the current `data` slice, for settings and repos.
     * @returns the next form.
     */
    function patchFormInto(form, patch, data) {
      const next = { ...form }
      const repos = Array.isArray(data?.repos) ? data.repos : []
      const settings = { ...defaultSettings(), ...(data?.settings ?? {}) }
      let repo = repos.find((entry) => String(entry?.id ?? '') === String(next.repoId)) ?? null

      if (Object.hasOwn(patch, 'repoId')) {
        next.repoId = String(patch.repoId ?? '')
        repo = repos.find((entry) => String(entry?.id ?? '') === next.repoId) ?? null
        next.branchTouched = false
        next.directoryTouched = false
        if (repo !== null) {
          next.baseBranch = String(repo.baseBranch ?? '')
          const parent = String(repo.parentDir ?? '')
          next.parentDir = parent.length > 0 ? parent : String(settings.defaultParentDir ?? '')
        }
      }
      if (Object.hasOwn(patch, 'url')) next.url = String(patch.url ?? '')
      if (Object.hasOwn(patch, 'baseBranch')) next.baseBranch = String(patch.baseBranch ?? '')
      if (Object.hasOwn(patch, 'parentDir')) next.parentDir = String(patch.parentDir ?? '')
      if (Object.hasOwn(patch, 'title')) next.title = String(patch.title ?? '')
      if (Object.hasOwn(patch, 'branch')) {
        next.branch = String(patch.branch ?? '')
        next.branchTouched = true
      }
      if (Object.hasOwn(patch, 'directoryName')) {
        next.directoryName = String(patch.directoryName ?? '')
        next.directoryTouched = true
      }
      if (Object.hasOwn(patch, 'name')) next.name = String(patch.name ?? '')

      // The two derived fields follow the name until the user overrides them,
      // and stay blank while there is nothing to derive them from.
      const label = repoLabelFor(repo, next.url)
      if (next.branchTouched !== true) {
        next.branch = next.name.trim().length === 0 ? '' : `${settings.branchPrefix ?? ''}${next.name.trim()}`
      }
      if (next.directoryTouched !== true) {
        next.directoryName = label.length === 0
          ? ''
          : directoryNameFor(settings.directoryTemplate, label, next.name, next.branch)
      }
      return next
    }

    const actions = {
      refresh: () => refresh(),

      /** @param patch - the create-form fields to change. @param target - 'create' or 'repo'. */
      patchForm(patch, target) {
        const current = source.getSnapshot()
        if (target === 'repo') {
          if (current.repoForm === null) return
          source.set({ repoForm: { ...current.repoForm, ...(patch ?? {}) } })
          return
        }
        source.set({ form: patchFormInto(current.form, patch ?? {}, current.data) })
      },

      /** @param patch - the settings-draft fields to change. */
      patchSettings(patch) {
        const current = source.getSnapshot()
        source.set({ settingsDraft: { ...current.settingsDraft, ...(patch ?? {}) }, settingsDirty: true })
      },

      /** Persist the settings draft. */
      async saveSettings() {
        const draft = source.getSnapshot().settingsDraft
        await guard('settings', async () => {
          const value = await call('settings/set', { patch: draft })
          const saved = { ...defaultSettings(), ...(value?.settings ?? draft) }
          const current = source.getSnapshot()
          source.set({
            settingsDraft: saved,
            settingsDirty: false,
            data: { ...current.data, settings: saved },
          })
          notice(T.settingsSaved)
        })
      },

      /** @param repo - the 仓库 record to open in the form, or null for a new one. */
      openRepoEditor(repo) {
        source.set({
          repoForm: repo === null || repo === undefined
            ? { id: '', url: '', name: '', baseBranch: '', parentDir: '' }
            : {
              id: String(repo.id ?? ''),
              url: String(repo.url ?? ''),
              name: String(repo.name ?? ''),
              baseBranch: String(repo.baseBranch ?? ''),
              parentDir: String(repo.parentDir ?? ''),
            },
        })
      },

      /** Close the 仓库 form without saving. */
      closeRepoEditor() {
        source.set({ repoForm: null })
      },

      /** @param repo - `Partial<Repo> & { url }`. */
      async saveRepo(repo) {
        const draft = repo ?? {}
        const url = String(draft.url ?? '').trim()
        if (url.length === 0) {
          notice(T.needRepoUrl)
          return
        }
        await guard('repo', async () => {
          await call('repos/save', {
            repo: {
              id: String(draft.id ?? ''),
              url,
              name: String(draft.name ?? '').trim(),
              baseBranch: String(draft.baseBranch ?? '').trim(),
              parentDir: String(draft.parentDir ?? '').trim(),
            },
          })
          source.set({ repoForm: null })
          notice(T.repoSaved)
          await refresh()
        })
      },

      /** @param id - the repo record to drop. */
      async removeRepo(id) {
        await guard('repo', async () => {
          await call('repos/remove', { id: String(id ?? '') })
          notice(T.repoRemoved)
          await refresh()
        })
      },

      /** @param url - the remote whose branches should be listed. */
      async loadBranches(url) {
        const target = String(url ?? '').trim()
        if (target.length === 0) {
          notice(T.needRepoUrl)
          return
        }
        setBranches(target, { phase: 'loading', list: [], head: '', error: '' })
        try {
          const value = await call('repos/branches', { url: target })
          if (disposed) return
          setBranches(target, {
            phase: 'ready',
            list: Array.isArray(value?.branches) ? value.branches.map((entry) => String(entry)) : [],
            head: typeof value?.head === 'string' ? value.head : '',
            error: '',
          })
        } catch (error) {
          if (disposed) return
          const message = messageOf(error)
          setBranches(target, { phase: 'error', list: [], head: '', error: message })
          notice(`${T.branchesFailed}${message}`)
        }
      },

      /** Submit the 「新建子工作区」 form as one background job. */
      async createWorkspace() {
        const current = source.getSnapshot()
        const form = current.form
        const name = form.name.trim()
        if (name.length === 0) {
          notice(T.needName)
          return
        }
        const adhoc = form.repoId === ''
        if (adhoc && form.url.trim().length === 0) {
          notice(T.needUrl)
          return
        }
        if (adhoc && form.baseBranch.trim().length === 0) {
          notice(T.needBaseBranch)
          return
        }
        await guard('create', async () => {
          const payload = {
            name,
            branch: form.branch.trim(),
            directoryName: form.directoryName.trim(),
            parentDir: form.parentDir.trim(),
            title: form.title.trim(),
          }
          if (adhoc) {
            payload.url = form.url.trim()
            payload.baseBranch = form.baseBranch.trim()
          } else {
            payload.repoId = form.repoId
          }
          const value = await call('workspaces/create', payload)
          notice(`${T.createQueued}${value?.job?.label ?? name}`)
          source.set({
            form: {
              ...source.getSnapshot().form,
              name: '',
              branch: '',
              branchTouched: false,
              directoryName: '',
              directoryTouched: false,
            },
            view: 'all',
          })
          capabilities.openPanel()
          await refresh()
          schedulePoll()
        })
      },

      /** @param id - the item to archive. @param deleteDirectory - also remove the folder. */
      async archiveItem(id, deleteDirectory) {
        await guard('archive', async () => {
          await call('workspaces/archive', { id: String(id ?? ''), deleteDirectory: deleteDirectory === true })
          source.set({ dialog: null })
          notice(deleteDirectory === true ? T.archivedWithDelete : T.archivedDone)
          await refresh()
        })
      },

      /** @param id - the archived item to put back on the DSH workspace list. */
      async restoreItem(id) {
        await guard('restore', async () => {
          await call('workspaces/restore', { id: String(id ?? '') })
          notice(T.restored)
          await refresh()
        })
      },

      /** @param id - the item whose record should disappear. @param deleteDirectory - also remove the folder. */
      async forgetItem(id, deleteDirectory) {
        await guard('forget', async () => {
          await call('workspaces/forget', { id: String(id ?? ''), deleteDirectory: deleteDirectory === true })
          source.set({ dialog: null })
          notice(T.forgotten)
          await refresh()
        })
      },

      /** @param id - the item to rename. @param patch - `{ name?, title? }`. */
      async renameItem(id, patch) {
        const next = patch ?? {}
        await guard('rename', async () => {
          await call('workspaces/rename', {
            id: String(id ?? ''),
            name: String(next.name ?? '').trim(),
            title: String(next.title ?? '').trim(),
          })
          source.set({ rename: null })
          notice(T.renamed)
          await refresh()
        })
      },

      /** @param item - the sub-workspace whose fresh session should open. */
      openSession(item) {
        const workspaceId = String(item?.workspaceId ?? '')
        if (workspaceId.length === 0) {
          notice(T.notRegistered)
          return
        }
        const service = capabilities.uiWorkspace()
        if (service === null || typeof service.startSession !== 'function') {
          notice(T.noNavigation)
          return
        }
        try {
          service.startSession(workspaceId)
          notice(T.opened)
        } catch (error) {
          notice(`${T.openFailed}${messageOf(error)}`)
        }
      },

      /** @param item - the sub-workspace whose blank session should open. */
      async reuseSession(item) {
        const workspaceId = String(item?.workspaceId ?? '')
        if (workspaceId.length === 0) {
          notice(T.notRegistered)
          return
        }
        const service = capabilities.uiWorkspace()
        if (service === null || typeof service.openWorkspace !== 'function') {
          notice(T.noNavigation)
          return
        }
        try {
          await service.openWorkspace(workspaceId)
          notice(T.reused)
        } catch (error) {
          notice(`${T.openFailed}${messageOf(error)}`)
        }
      },

      /** @param target - 'create', 'repo' or 'settings': which parent-directory field to fill. */
      async pickParentDir(target) {
        const service = capabilities.uiWorkspace()
        if (service === null || typeof service.pickDirectory !== 'function') {
          notice(T.noPicker)
          return
        }
        const scope = target === 'repo' ? 'repo' : target === 'settings' ? 'settings' : 'create'
        await guard('pick', async () => {
          try {
            const chosen = await service.pickDirectory()
            if (chosen === null || typeof chosen !== 'string' || chosen.length === 0) return
            if (scope === 'settings') actions.patchSettings({ defaultParentDir: chosen })
            else actions.patchForm({ parentDir: chosen }, scope)
          } catch (error) {
            notice(`${T.pickFailed}${messageOf(error)}`)
          }
        })
      },

      /** @param path - an absolute directory to hand to the platform file manager. */
      async revealPath(path) {
        const target = String(path ?? '')
        if (target.length === 0) return
        await guard('reveal', async () => {
          const value = await call('fs/reveal', { path: target })
          notice(value?.revealed === true ? `${T.revealed}${target}` : `${T.revealFailed}${target}`)
        })
      },

      /** @param id - the running job to stop. */
      async cancelJob(id) {
        await guard('cancel', async () => {
          const value = await call('jobs/cancel', { id: String(id ?? '') })
          notice(value?.cancelled === true ? T.cancelRequested : T.cancelFailed)
          await refresh()
        })
      },

      /** @param item - the item to archive through the confirm dialog. */
      openArchiveDialog(item) {
        if (item === null || item === undefined) return
        source.set({
          dialog: {
            kind: 'archive',
            id: String(item.id ?? ''),
            name: String(item.title || item.name || ''),
            deleteDirectory: source.getSnapshot().data.settings.deleteDirectoryOnArchive === true,
          },
        })
      },

      /** @param item - the item whose record should be dropped through the confirm dialog. */
      openForgetDialog(item) {
        if (item === null || item === undefined) return
        source.set({
          dialog: {
            kind: 'forget',
            id: String(item.id ?? ''),
            name: String(item.title || item.name || ''),
            deleteDirectory: false,
          },
        })
      },

      closeDialog() {
        source.set({ dialog: null })
      },

      /** @param value - whether the dialog's 「同时删除本地目录」 box is ticked. */
      setDialogDelete(value) {
        const dialog = source.getSnapshot().dialog
        if (dialog === null) return
        source.set({ dialog: { ...dialog, deleteDirectory: value === true } })
      },

      /** @param item - the item to rename through the dialog. */
      openRenameDialog(item) {
        if (item === null || item === undefined) return
        source.set({
          rename: {
            id: String(item.id ?? ''),
            name: String(item.name ?? ''),
            title: String(item.title ?? ''),
          },
        })
      },

      closeRename() {
        source.set({ rename: null })
      },

      /** @param patch - `{ name?, title? }` for the open rename dialog. */
      patchRename(patch) {
        const rename = source.getSnapshot().rename
        if (rename === null) return
        source.set({ rename: { ...rename, ...(patch ?? {}) } })
      },

      /** @param view - 'all' | 'active' | 'archived'. */
      setView(view) {
        source.set({ view: view === 'active' || view === 'archived' ? view : 'all' })
      },

      /** Bring this page forward through the layout service. */
      openPanel() {
        capabilities.openPanel()
      },

      dismissNotice() {
        source.set({ notice: '' })
      },
    }

    return {
      source,
      actions,
      dispose() {
        disposed = true
        stopPoll()
      },
    }
  }

  /**
   * A two-step confirm button: the first press arms it, the second runs the
   * destructive action. Disarming happens on a timer or on blur.
   * @param props - label, confirmLabel, onConfirm and optional title/className.
   */
  function ConfirmButton({ label, confirmLabel, onConfirm, title, className }) {
    const [armed, setArmed] = React.useState(false)
    React.useEffect(() => {
      if (!armed) return undefined
      const timer = setTimeout(() => setArmed(false), 4000)
      return () => clearTimeout(timer)
    }, [armed])
    return h(Button, {
      variant: 'ghost',
      className,
      title: title ?? label,
      'aria-label': title ?? label,
      onClick: () => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      },
      onBlur: () => setArmed(false),
    }, armed ? confirmLabel : label)
  }

  /**
   * One status chip: a state dot plus the words it stands for (the dot itself
   * is decorative).
   * @param props - state, label and optional title.
   */
  function StateChip({ state, label, title }) {
    return h('span', { className: 'wsm-dot', title: title ?? label },
      h(StateDot, { state }),
      h('span', { className: 'wsm-dot-label' }, label),
    )
  }

  /** @param status - an `ItemStatus`, possibly absent. @returns the chip row. */
  function statusChips(status) {
    const value = status ?? {}
    const chips = [
      h(StateChip, {
        key: 'exists',
        state: value.exists === true ? 'done' : 'error',
        label: value.exists === true ? T.exists : T.missing,
      }),
      h(StateChip, {
        key: 'registered',
        state: value.registered === true ? 'done' : 'idle',
        label: value.registered === true ? T.registered : T.unregistered,
      }),
    ]
    if (value.exists === true) {
      chips.push(h(StateChip, {
        key: 'dirty',
        state: value.dirty === true ? 'warning' : 'done',
        label: value.dirty === true ? T.dirty : T.clean,
      }))
    }
    if (typeof value.ahead === 'number' && value.ahead >= 0) {
      chips.push(h(StateChip, { key: 'ahead', state: 'idle', label: `${T.ahead}${value.ahead}` }))
    }
    if (typeof value.behind === 'number' && value.behind >= 0) {
      chips.push(h(StateChip, { key: 'behind', state: 'idle', label: `${T.behind}${value.behind}` }))
    }
    return chips
  }

  /**
   * One sub-workspace card.
   * @param props - the item, the actions and whether it is the archived form.
   */
  function ItemCard({ item, actions, archived, busy }) {
    const status = item.status ?? {}
    const workspaceId = String(item.workspaceId ?? '')
    const canOpen = workspaceId.length > 0
    const stateChip = archived
      ? { tone: 'quiet', label: T.groupArchived }
      : status.exists !== true
        ? { tone: 'danger', label: T.missing }
        : status.dirty === true
          ? { tone: 'warning', label: T.dirty }
          : { tone: 'success', label: T.groupActive }
    return h('div', { className: 'wsm-card', 'data-muted': archived ? 'true' : 'false' },
      h('div', { className: 'wsm-card-head' },
        h('div', { className: 'wsm-card-body' },
          h('div', { className: 'wsm-title-row' },
            h('span', { className: 'wsm-card-title' }, item.title || item.name),
            h(Tag, { tone: stateChip.tone }, stateChip.label),
          ),
          h('div', { className: 'wsm-meta' },
            h('span', null, h('b', null, `${T.branch}：`), String(item.branch ?? '')),
            h('span', null, h('b', null, `${T.fromBranch}：`), String(item.baseBranch ?? '')),
            h('span', null, String(item.repoName ?? '') || T.adhoc),
            archived ? h('span', null, `${T.archivedAt}${timeText(item.archivedAt)}`) : null,
            h('span', null, `${T.workspaceId}${canOpen ? workspaceId : T.unregistered}`),
          ),
          h('span', { className: 'wsm-path', title: String(item.path ?? '') }, String(item.path ?? '')),
          h('div', { className: 'wsm-dots' }, statusChips(status)),
          typeof status.error === 'string' && status.error.length > 0
            ? h('div', { className: 'wsm-hint wsm-danger', title: status.error }, `${T.observeError}${status.error}`)
            : null,
        ),
        h('div', { className: 'wsm-card-actions' },
          archived
            ? h(Button, {
              variant: 'primary',
              icon: icon(IconArchiveOffOutlineRegular),
              disabled: busy.restore === true,
              title: T.restore,
              onClick: () => { void actions.restoreItem(item.id) },
            }, T.restore)
            : h(Button, {
              variant: 'primary',
              icon: icon(IconPlayOutlineRegular),
              disabled: !canOpen,
              title: canOpen ? T.openSession : T.notRegistered,
              onClick: () => actions.openSession(item),
            }, T.openSession),
          archived
            ? null
            : h(Button, {
              disabled: !canOpen,
              title: canOpen ? T.reuseSession : T.notRegistered,
              onClick: () => { void actions.reuseSession(item) },
            }, T.reuseSession),
          h(Button, {
            icon: icon(IconEditOutlineRegular),
            title: T.rename,
            onClick: () => actions.openRenameDialog(item),
          }, T.rename),
          h(Button, {
            icon: icon(IconFolderOpenOutlineRegular),
            disabled: busy.reveal === true,
            title: T.reveal,
            onClick: () => { void actions.revealPath(item.path) },
          }, T.reveal),
          archived
            ? h(Button, {
              variant: 'ghost',
              className: 'wsm-danger',
              icon: icon(IconTrashOutlineRegular),
              title: T.forgetTitle,
              onClick: () => actions.openForgetDialog(item),
            }, T.forget)
            : h(Button, {
              variant: 'ghost',
              className: 'wsm-danger',
              icon: icon(IconArchiveOutlineRegular),
              title: T.archive,
              onClick: () => actions.openArchiveDialog(item),
            }, T.archive),
        ),
      ),
    )
  }

  /**
   * The 默认开发分支 control: a `repos/branches` list plus free text.
   * @param props - url, value, branches state and the change/load callbacks.
   */
  function BranchPicker({ url, value, branches, loading, onChange, onLoad }) {
    const [custom, setCustom] = React.useState(false)
    const options = Array.isArray(branches) ? branches : []
    const known = options.includes(value)
    // An unknown value is free text: it either came from a saved repo or from
    // the user, and either way the select cannot show it as an option.
    const free = custom || (value !== '' && !known)
    return h('div', { className: 'wsm-input-row' },
      h('select', {
        className: 'wsm-select',
        value: free ? '__custom__' : (known ? value : ''),
        disabled: loading,
        'aria-label': T.baseBranch,
        title: T.baseBranchHint,
        onChange: (event) => {
          if (event.target.value === '__custom__') {
            setCustom(true)
            return
          }
          setCustom(false)
          onChange(event.target.value)
        },
      },
        h('option', { value: '' }, loading ? T.loadingBranches : T.baseBranchPlaceholder),
        options.map((branch) => h('option', { key: branch, value: branch }, branch)),
        h('option', { value: '__custom__' }, T.customBranch),
      ),
      free
        ? h(Input, {
          value,
          placeholder: T.baseBranchPlaceholder,
          'aria-label': T.baseBranch,
          onChange: (event) => onChange(event.target.value),
        })
        : null,
      h(Button, {
        size: 'sm',
        variant: 'outline',
        disabled: loading || String(url ?? '').trim().length === 0,
        title: T.baseBranchHint,
        onClick: () => onLoad(url),
      }, loading ? T.loadingBranches : T.loadBranches),
    )
  }

  /**
   * The 仓库 add/edit form.
   * @param props - the store state and actions.
   */
  function RepoForm({ state, actions }) {
    const form = state.repoForm
    if (form === null) return null
    const editing = String(form.id ?? '').length > 0
    const entry = state.branches[String(form.url ?? '').trim()] ?? null
    const loading = entry?.phase === 'loading'
    return h('div', { className: 'wsm-form-card' },
      h('div', { className: 'wsm-form' },
        h('div', { className: 'wsm-field', 'data-wide': 'true' },
          h('span', { className: 'wsm-field-label' }, T.repoUrl),
          h(Input, {
            value: form.url,
            placeholder: T.repoUrlPlaceholder,
            'aria-label': T.repoUrl,
            onChange: (event) => actions.patchForm({ url: event.target.value }, 'repo'),
          }),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.repoName),
          h(Input, {
            value: form.name,
            placeholder: T.repoNamePlaceholder,
            'aria-label': T.repoName,
            onChange: (event) => actions.patchForm({ name: event.target.value }, 'repo'),
          }),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.baseBranch),
          h(BranchPicker, {
            url: form.url,
            value: String(form.baseBranch ?? ''),
            branches: entry?.list,
            loading,
            onChange: (next) => actions.patchForm({ baseBranch: next }, 'repo'),
            onLoad: (url) => { void actions.loadBranches(url) },
          }),
          entry?.phase === 'ready' && entry.head
            ? h('span', { className: 'wsm-hint' }, `${T.branchesHead}${entry.head}`)
            : null,
          entry?.phase === 'error'
            ? h('span', { className: 'wsm-hint wsm-danger' }, `${T.branchesFailed}${entry.error}`)
            : null,
        ),
        h('div', { className: 'wsm-field', 'data-wide': 'true' },
          h('span', { className: 'wsm-field-label' }, T.parentDir),
          h('div', { className: 'wsm-input-row' },
            h(Input, {
              value: form.parentDir,
              placeholder: T.parentDirPlaceholder,
              'aria-label': T.parentDir,
              onChange: (event) => actions.patchForm({ parentDir: event.target.value }, 'repo'),
            }),
            h(Button, {
              icon: icon(IconBrowseOutlineRegular),
              disabled: state.busy.pick === true,
              title: T.pickDir,
              onClick: () => { void actions.pickParentDir('repo') },
            }, T.pickDir),
          ),
        ),
      ),
      h('div', { className: 'wsm-actions', style: { marginTop: '12px' } },
        h(Button, { onClick: actions.closeRepoEditor }, T.cancel),
        h(Button, {
          variant: 'primary',
          disabled: state.busy.repo === true,
          onClick: () => { void actions.saveRepo(form) },
        }, T.saveRepo),
      ),
    )
  }

  /**
   * One saved-repo card.
   * @param props - the repo, its branch state and the actions.
   */
  function RepoCard({ repo, entry, actions, busy }) {
    const loading = entry?.phase === 'loading'
    return h('div', { className: 'wsm-card' },
      h('div', { className: 'wsm-card-head' },
        h('div', { className: 'wsm-card-body' },
          h('div', { className: 'wsm-title-row' },
            h('span', { className: 'wsm-card-title' }, String(repo.name ?? '') || String(repo.url ?? '')),
            h(Tag, { tone: 'outline' }, String(repo.baseBranch ?? '') || '—'),
          ),
          h('div', { className: 'wsm-meta' },
            h('span', null, h('b', null, `${T.baseBranch}：`), String(repo.baseBranch ?? '') || '—'),
            h('span', null, h('b', null, `${T.parentDir}：`), String(repo.parentDir ?? '') || '—'),
          ),
          h('span', { className: 'wsm-path', title: String(repo.url ?? '') }, String(repo.url ?? '')),
          entry?.phase === 'ready'
            ? h('div', { className: 'wsm-meta' },
              h('span', null, `${T.branchesHead}${entry.head || '—'}`),
              h('span', null, `${entry.list.length} 个分支`),
            )
            : null,
          entry?.phase === 'error'
            ? h('div', { className: 'wsm-hint wsm-danger' }, `${T.branchesFailed}${entry.error}`)
            : null,
        ),
        h('div', { className: 'wsm-card-actions' },
          h(Button, {
            icon: icon(IconBranchOutlineRegular),
            disabled: loading,
            title: T.loadBranches,
            onClick: () => {
              // The 「分支」 button loads the list into the editor's select, so
              // the picker it fills is on screen right away.
              actions.openRepoEditor(repo)
              void actions.loadBranches(repo.url)
            },
          }, loading ? T.loadingBranches : T.loadBranches),
          h(Button, {
            icon: icon(IconEditOutlineRegular),
            onClick: () => actions.openRepoEditor(repo),
          }, T.editRepo),
          h(ConfirmButton, {
            label: T.removeRepo,
            confirmLabel: T.removeRepoAgain,
            className: 'wsm-danger',
            title: `${T.removeRepo}：${String(repo.name ?? '')}`,
            onConfirm: () => { void actions.removeRepo(repo.id) },
          }),
        ),
      ),
    )
  }

  /**
   * The 「新建子工作区」 form.
   * @param props - the store state and actions.
   */
  function CreateForm({ state, actions, runningJob }) {
    const form = state.form
    const repos = Array.isArray(state.data.repos) ? state.data.repos : []
    const adhoc = form.repoId === ''
    const entry = state.branches[String(form.url ?? '').trim()] ?? null
    const creating = state.busy.create === true
    const running = creating && runningJob !== null && runningJob !== undefined
    return h('div', { className: 'wsm-form-card' },
      h('div', { className: 'wsm-form' },
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.pickRepo),
          h('select', {
            className: 'wsm-select',
            value: form.repoId,
            'aria-label': T.pickRepo,
            onChange: (event) => actions.patchForm({ repoId: event.target.value }),
          },
            h('option', { value: '' }, T.adhocRepo),
            repos.map((repo) => h('option', {
              key: String(repo.id),
              value: String(repo.id),
            }, String(repo.name ?? '') || String(repo.url ?? ''))),
          ),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.name),
          h(Input, {
            value: form.name,
            placeholder: T.namePlaceholder,
            'aria-label': T.name,
            onChange: (event) => actions.patchForm({ name: event.target.value }),
          }),
          h('span', { className: 'wsm-hint' }, T.nameHint),
        ),
        adhoc
          ? h('div', { className: 'wsm-field', 'data-wide': 'true' },
            h('span', { className: 'wsm-field-label' }, T.repoUrl),
            h(Input, {
              value: form.url,
              placeholder: T.repoUrlPlaceholder,
              'aria-label': T.repoUrl,
              onChange: (event) => actions.patchForm({ url: event.target.value }),
            }),
          )
          : null,
        adhoc
          ? h('div', { className: 'wsm-field' },
            h('span', { className: 'wsm-field-label' }, T.baseBranch),
            h(BranchPicker, {
              url: form.url,
              value: form.baseBranch,
              branches: entry?.list,
              loading: entry?.phase === 'loading',
              onChange: (next) => actions.patchForm({ baseBranch: next }),
              onLoad: (url) => { void actions.loadBranches(url) },
            }),
          )
          : h('div', { className: 'wsm-field' },
            h('span', { className: 'wsm-field-label' }, T.fromBranch),
            h('div', { className: 'wsm-readonly' }, form.baseBranch || T.fromBranchUnknown),
          ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.branch),
          h(Input, {
            value: form.branch,
            placeholder: T.branchPlaceholder,
            'aria-label': T.branch,
            onChange: (event) => actions.patchForm({ branch: event.target.value }),
          }),
          h('span', { className: 'wsm-hint' }, T.branchHint),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.directoryName),
          h(Input, {
            value: form.directoryName,
            placeholder: T.namePlaceholder,
            'aria-label': T.directoryName,
            onChange: (event) => actions.patchForm({ directoryName: event.target.value }),
          }),
          h('span', { className: 'wsm-hint' }, T.directoryHint),
        ),
        h('div', { className: 'wsm-field', 'data-wide': 'true' },
          h('span', { className: 'wsm-field-label' }, T.parentDir),
          h('div', { className: 'wsm-input-row' },
            h(Input, {
              value: form.parentDir,
              placeholder: T.parentDirPlaceholder,
              'aria-label': T.parentDir,
              onChange: (event) => actions.patchForm({ parentDir: event.target.value }),
            }),
            h(Button, {
              icon: icon(IconBrowseOutlineRegular),
              disabled: state.busy.pick === true,
              title: T.pickDir,
              onClick: () => { void actions.pickParentDir('create') },
            }, T.pickDir),
          ),
          h('span', { className: 'wsm-hint' }, T.parentDirPlaceholder),
        ),
      ),
      h('div', { className: 'wsm-actions', style: { marginTop: '14px' } },
        h(Button, {
          variant: 'primary',
          icon: icon(IconPlusOutlineRegular),
          disabled: creating,
          onClick: () => { void actions.createWorkspace() },
        }, running ? `${T.creating}${String(runningJob.step ?? '')}` : T.create),
      ),
    )
  }

  /**
   * The job strip: the running job's label, step, progress and tail of its log.
   * @param props - the shown job and the actions.
   */
  function JobStrip({ job, actions, busy }) {
    if (job === null || job === undefined) return null
    const running = job.status === 'running'
    const progress = typeof job.progress === 'number' ? job.progress : -1
    const indeterminate = !(progress >= 0)
    const log = Array.isArray(job.log) ? job.log.slice(-JOB_LOG_LINES) : []
    const statusText = running
      ? T.jobRunning
      : job.status === 'ok'
        ? T.jobOk
        : job.status === 'cancelled'
          ? T.jobCancelled
          : T.jobFailed
    return h('div', { className: 'wsm-job' },
      h('div', { className: 'wsm-job-head' },
        h('div', { className: 'wsm-job-title' },
          h('b', null, `${statusText} · `),
          String(job.label ?? ''),
          String(job.step ?? '').length > 0 ? ` — ${String(job.step)}` : '',
        ),
        running
          ? h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: busy.cancel === true,
            title: T.cancelJob,
            onClick: () => { void actions.cancelJob(job.id) },
          }, T.cancelJob)
          : null,
      ),
      running || progress >= 0
        ? h('div', { className: 'wsm-bar', 'data-indeterminate': indeterminate ? 'true' : 'false' },
          h('div', {
            className: 'wsm-bar-fill',
            style: indeterminate ? undefined : { width: `${Math.max(2, Math.min(100, progress * 100))}%` },
          }),
        )
        : null,
      job.error
        ? h('div', { className: 'wsm-hint wsm-danger' }, String(job.error))
        : null,
      log.length > 0
        ? h('div', null,
          h('div', { className: 'wsm-hint' }, T.jobLog),
          h('div', { className: 'wsm-log' }, log.map((line, index) => h('div', {
            key: `${String(line?.at ?? index)}-${index}`,
            className: line?.level === 'error' ? 'wsm-log-error' : line?.level === 'warn' ? 'wsm-log-warn' : undefined,
          }, `${timeText(line?.at)} [${String(line?.level ?? 'info')}] ${String(line?.text ?? '')}`))),
        )
        : null,
    )
  }

  /**
   * The 设置 block: Host-side defaults the whole manager obeys.
   * @param props - the store state and actions.
   */
  function SettingsSection({ state, actions }) {
    const draft = state.settingsDraft
    return h('details', { className: 'wsm-details' },
      h('summary', null, T.settings),
      h('div', { className: 'wsm-hint', style: { marginBottom: '6px' } }, T.settingsHint),
      h('div', { className: 'wsm-settings' },
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.settingsParentDir),
          h('div', { className: 'wsm-input-row' },
            h(Input, {
              value: String(draft.defaultParentDir ?? ''),
              placeholder: T.parentDirPlaceholder,
              'aria-label': T.settingsParentDir,
              onChange: (event) => actions.patchSettings({ defaultParentDir: event.target.value }),
            }),
            h(Button, {
              icon: icon(IconBrowseOutlineRegular),
              disabled: state.busy.pick === true,
              title: T.pickDir,
              onClick: () => { void actions.pickParentDir('settings') },
            }, T.pickDir),
          ),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.settingsTemplate),
          h(Input, {
            value: String(draft.directoryTemplate ?? ''),
            'aria-label': T.settingsTemplate,
            onChange: (event) => actions.patchSettings({ directoryTemplate: event.target.value }),
          }),
          h('span', { className: 'wsm-hint' }, T.settingsTemplateHint),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.settingsPrefix),
          h(Input, {
            value: String(draft.branchPrefix ?? ''),
            'aria-label': T.settingsPrefix,
            onChange: (event) => actions.patchSettings({ branchPrefix: event.target.value }),
          }),
          h('span', { className: 'wsm-hint' }, T.settingsPrefixHint),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.settingsDepth),
          h(Input, {
            type: 'number',
            value: String(draft.cloneDepth ?? 0),
            'aria-label': T.settingsDepth,
            onChange: (event) => actions.patchSettings({ cloneDepth: toInt(event.target.value, 0) }),
          }),
          h('span', { className: 'wsm-hint' }, T.settingsDepthHint),
        ),
        h('div', { className: 'wsm-field' },
          h('span', { className: 'wsm-field-label' }, T.settingsConcurrency),
          h(Input, {
            type: 'number',
            value: String(draft.concurrency ?? 1),
            'aria-label': T.settingsConcurrency,
            onChange: (event) => actions.patchSettings({ concurrency: Math.max(1, toInt(event.target.value, 1)) }),
          }),
        ),
        h('div', { className: 'wsm-field' },
          h(Checkbox, {
            checked: draft.partialClone === true,
            label: T.settingsPartial,
            onChange: (next) => actions.patchSettings({ partialClone: next }),
          }),
          h(Checkbox, {
            checked: draft.fetchBeforeCreate === true,
            label: T.settingsFetch,
            onChange: (next) => actions.patchSettings({ fetchBeforeCreate: next }),
          }),
          h(Checkbox, {
            checked: draft.deleteDirectoryOnArchive === true,
            label: T.settingsDelete,
            onChange: (next) => actions.patchSettings({ deleteDirectoryOnArchive: next }),
          }),
          h(Checkbox, {
            checked: draft.autoOpenSession === true,
            label: T.settingsAutoOpen,
            onChange: (next) => actions.patchSettings({ autoOpenSession: next }),
          }),
        ),
      ),
      h('div', { className: 'wsm-actions', style: { marginTop: '12px' } },
        h(Button, {
          variant: 'primary',
          disabled: state.busy.settings === true || state.settingsDirty !== true,
          onClick: () => { void actions.saveSettings() },
        }, T.saveSettings),
      ),
    )
  }

  /**
   * The archive/forget confirmation dialog.
   * @param props - the store state and actions.
   */
  function ConfirmDialog({ state, actions }) {
    const dialog = state.dialog
    if (dialog === null) return null
    const forget = dialog.kind === 'forget'
    const pending = forget ? state.busy.forget === true : state.busy.archive === true
    return h(Modal, {
      open: true,
      onClose: actions.closeDialog,
      closeLabel: T.close,
      title: forget ? T.forgetTitle : T.archiveTitle,
    },
      h('p', { className: 'wsm-dialog-text' }, forget ? T.forgetBody : T.archiveBody),
      h('div', { className: 'wsm-dialog-name' }, dialog.name),
      h(Checkbox, {
        checked: dialog.deleteDirectory === true,
        onChange: actions.setDialogDelete,
        label: T.deleteDirectory,
        title: T.deleteDirectoryWarn,
      }),
      dialog.deleteDirectory === true
        ? h('div', { className: 'wsm-hint wsm-danger', style: { marginTop: '6px' } }, T.deleteDirectoryWarn)
        : null,
      h('div', { className: 'wsm-modal-actions' },
        h(Button, { onClick: actions.closeDialog }, T.cancel),
        h(Button, {
          variant: 'primary',
          disabled: pending,
          onClick: () => {
            if (forget) void actions.forgetItem(dialog.id, dialog.deleteDirectory === true)
            else void actions.archiveItem(dialog.id, dialog.deleteDirectory === true)
          },
        }, forget ? T.forget : T.archive),
      ),
    )
  }

  /**
   * The rename dialog: our record's name plus the DSH session title.
   * @param props - the store state and actions.
   */
  function RenameDialog({ state, actions }) {
    const rename = state.rename
    if (rename === null) return null
    return h(Modal, {
      open: true,
      onClose: actions.closeRename,
      closeLabel: T.close,
      title: T.renameTitle,
    },
      h('div', { className: 'wsm-field' },
        h('span', { className: 'wsm-field-label' }, T.name),
        h(Input, {
          value: rename.name,
          'aria-label': T.name,
          'data-modal-autofocus': true,
          onChange: (event) => actions.patchRename({ name: event.target.value }),
        }),
      ),
      h('div', { className: 'wsm-field', style: { marginTop: '10px' } },
        h('span', { className: 'wsm-field-label' }, T.renameTitleField),
        h(Input, {
          value: rename.title,
          'aria-label': T.renameTitleField,
          onChange: (event) => actions.patchRename({ title: event.target.value }),
        }),
        h('span', { className: 'wsm-hint' }, T.renameTitleHint),
      ),
      h('div', { className: 'wsm-modal-actions' },
        h(Button, { onClick: actions.closeRename }, T.cancel),
        h(Button, {
          variant: 'primary',
          disabled: state.busy.rename === true,
          onClick: () => { void actions.renameItem(rename.id, { name: rename.name, title: rename.title }) },
        }, T.save),
      ),
    )
  }

  /**
   * The 并发工作区 page registered into the keyed `main` slot.
   * @param props - standard seats plus the injected `workspaceManager` actions
   * and the `useWorkspaceManager` hook.
   */
  function PanelPage(props) {
    const state = props.useWorkspaceManager((snapshot) => snapshot)
    const actions = props.workspaceManager
    React.useEffect(() => { void actions.refresh() }, [actions])
    React.useEffect(() => {
      if (state.notice === '') return undefined
      const timer = setTimeout(() => actions.dismissNotice(), NOTICE_MS)
      return () => { clearTimeout(timer) }
    }, [state.noticeSeq, state.notice, actions])

    const data = state.data
    const repos = Array.isArray(data.repos) ? data.repos : []
    const items = Array.isArray(data.items) ? data.items : []
    const jobs = Array.isArray(data.jobs) ? data.jobs : []
    const stores = data.stores ?? {}
    const active = items.filter((item) => item?.archived !== true)
    const archived = items.filter((item) => item?.archived === true)
    const running = jobs.filter((job) => job?.status === 'running')
    const runningCreate = running.find((job) => job?.kind === 'create') ?? null
    const newest = jobs.slice().sort((left, right) =>
      String(left?.startedAt ?? '').localeCompare(String(right?.startedAt ?? ''))).pop() ?? null
    const shownJob = running[0] ?? newest
    const view = state.view === 'active' || state.view === 'archived' ? state.view : 'all'
    const showActive = view !== 'archived'
    const showArchived = view !== 'active'

    return h('div', { className: 'wsm-page' },
      h('div', { className: 'wsm-scroll' },
        h('div', { className: 'wsm-content' },
          h('div', { className: 'wsm-head' },
            h('div', null,
              h('h1', null, T.title),
              h('div', { className: 'wsm-sub' },
                `${T.subtitle} · ${T.groupActive} ${active.length} · ${T.groupArchived} ${archived.length}`),
            ),
            h('div', { className: 'wsm-head-actions' },
              h(Button, {
                icon: icon(IconRefreshOutlineRegular),
                title: T.refresh,
                onClick: () => { void actions.refresh() },
              }, T.refresh),
            ),
          ),

          typeof stores.writeError === 'string' && stores.writeError.length > 0
            ? h('div', { className: 'wsm-warn' }, `${T.storageDown}${stores.writeError}`)
            : null,
          state.phase === 'ready' && (stores.gitPath === null || stores.gitPath === undefined)
            ? h('div', { className: 'wsm-warn' },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                icon(IconWarningOutlineRegular),
                h('span', null, T.gitMissing),
              ),
            )
            : null,
          state.phase === 'error' && state.error
            ? h('div', { className: 'wsm-warn' }, state.error)
            : null,

          state.notice === ''
            ? null
            : h('div', { className: 'wsm-notice' },
              h('span', { className: 'wsm-notice-text', key: state.noticeSeq, role: 'status' }, state.notice),
              h(Button, { size: 'sm', onClick: actions.dismissNotice }, T.dismiss),
            ),

          h('section', { className: 'wsm-section' },
            h('div', { className: 'wsm-section-head' },
              h('div', null,
                h('h2', null, T.repos),
                h('div', { className: 'wsm-section-sub' }, T.reposHint),
              ),
              h('div', { className: 'wsm-section-tools' },
                h(Button, {
                  variant: 'primary',
                  icon: icon(IconPlusOutlineRegular),
                  onClick: () => actions.openRepoEditor(null),
                }, T.addRepo),
              ),
            ),
            h(RepoForm, { state, actions }),
            repos.length === 0
              ? h('div', { className: 'wsm-empty' }, state.phase === 'loading' ? T.loading : T.emptyRepos)
              : repos.map((repo) => h(RepoCard, {
                key: String(repo.id),
                repo,
                entry: state.branches[String(repo.url ?? '').trim()] ?? null,
                actions,
                busy: state.busy,
              })),
          ),

          h('section', { className: 'wsm-section' },
            h('div', { className: 'wsm-section-head' },
              h('div', null,
                h('h2', null, T.createTitle),
                h('div', { className: 'wsm-section-sub' }, T.createHint),
              ),
            ),
            h(CreateForm, { state, actions, runningJob: runningCreate }),
          ),

          h('section', { className: 'wsm-section' },
            h('div', { className: 'wsm-section-head' },
              h('div', null,
                h('h2', null, T.items),
                h('div', { className: 'wsm-section-sub' }, T.itemsHint),
              ),
              h('div', { className: 'wsm-section-tools wsm-tabs' },
                h(SegmentedTabs, {
                  items: [
                    { value: 'all', label: `${T.viewAll} (${items.length})` },
                    { value: 'active', label: `${T.viewActive} (${active.length})` },
                    { value: 'archived', label: `${T.viewArchived} (${archived.length})` },
                  ],
                  value: view,
                  onChange: actions.setView,
                  label: T.viewLabel,
                }),
              ),
            ),
            showActive
              ? (active.length === 0
                ? h('div', { className: 'wsm-empty' }, state.phase === 'loading' ? T.loading : T.emptyItems)
                : active.map((item) => h(ItemCard, {
                  key: String(item.id),
                  item,
                  actions,
                  archived: false,
                  busy: state.busy,
                })))
              : null,
            showArchived
              ? h('details', { className: 'wsm-details', open: view === 'archived' },
                h('summary', null, `${T.groupArchived} (${archived.length})`),
                archived.length === 0
                  ? h('div', { className: 'wsm-empty' }, state.phase === 'loading' ? T.loading : T.emptyArchived)
                  : archived.map((item) => h(ItemCard, {
                    key: String(item.id),
                    item,
                    actions,
                    archived: true,
                    busy: state.busy,
                  })),
              )
              : null,
          ),

          h('section', { className: 'wsm-section' },
            h('div', { className: 'wsm-section-head' },
              h('div', null,
                h('h2', null, T.jobs),
                h('div', { className: 'wsm-section-sub' }, `${T.jobRunning} ${running.length} / ${jobs.length}`),
              ),
            ),
            h(JobStrip, { job: shownJob, actions, busy: state.busy }),
          ),

          h(SettingsSection, { state, actions }),

          h('div', { className: 'wsm-footer' },
            stores.file
              ? h('span', { className: 'wsm-path', title: String(stores.file) }, `${T.storeFile}${String(stores.file)}`)
              : null,
            stores.gitPath
              ? h('span', null, `${T.gitFound}${String(stores.gitPath)}${stores.gitVersion ? ` (${String(stores.gitVersion)})` : ''}`)
              : null,
          ),

          h(ConfirmDialog, { state, actions }),
          h(RenameDialog, { state, actions }),
        ),
      ),
    )
  }

  /** The sidebar row's glyph: bare, as every panel row supplies it. */
  function PanelIcon({ size }) {
    return icon(IconWorkspaceTreeOutlineRegular, size ?? 16)
  }

  return {
    name: 'workspaceManager.client',
    inject: ['slots', 'connection', 'layout'],
    apply(ctx) {
      injectStyle()
      const call = createCaller(ctx.connection)
      const store = createStore(call, {
        /**
         * The optional Workspace navigation service. Read through `ctx.get` so a
         * client without it still loads this panel.
         * @returns the service, or null.
         */
        uiWorkspace: () => {
          const service = ctx.get('uiWorkspace')
          return service === undefined || service === null ? null : service
        },
        /** Bring this page forward. */
        openPanel: () => {
          try {
            ctx.layout.selectPanel(PANEL_ID)
          } catch {
            // The panel registration owns navigation; a not-yet-registered
            // panel is not a failure of the operation that asked for it.
          }
        },
      })

      // One stable face for every seat: the source identity must not move, or
      // the renderer would rebind the hook on each registration.
      const injected = { hooks: { workspaceManager: store.source }, workspaceManager: store.actions }
      const face = () => injected

      ctx.effect(() => () => store.dispose(), 'workspace-manager: store')

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: face,
      }, PanelPage))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 45,
        label: T.panel,
      }, PanelIcon))
    },
  }
}
