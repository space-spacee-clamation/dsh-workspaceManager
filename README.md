# dsh-workspace-manager（并发工作区）

[English](README.md) | 中文

## 这个插件解决什么

想同时推进一个项目的几个方向，又不想在同一个仓库里改来改去，正常的手工流程是：

1. 新建一个文件夹；
2. `git clone` 对应的仓库进去；
3. 在 DSH 里把那个文件夹加成工作区；
4. 切一个新分支；
5. 再开一个会话。

每一步都不难，但每一步都要手动做，而且分支名、目录名、父目录每次都要重新想一遍。

这个插件把整条流程收进 DSH 的一个面板里：**登记一个仓库 → 填个名字 → 点一下**，剩下的克隆、切分支、注册工作区、开会话全部自动完成；不用了就归档，工作区直接从 DSH 的工作区列表里消失，目录还留在原地。

## 安装

插件以 DSH bundle 的形式安装，装完**不需要重启**——DSH 启动器自带的 `watchUserPatches` 会热挂载新的 patch 行。

### 方式一：从 GitHub 安装（推荐）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add github:space-spacee-clamation/dsh-workspaceManager
```

然后在该 profile 的 `cordis.patch.yml` 末尾追加一行（如果文件末尾是 `[]`，就把它整行替换成下面两块）：

```yaml
- insert:
    - id: workspace-manager
      name: dsh-workspace-manager
```

保存后 patch 层会热加载。浏览器标签页刷新一次，左侧栏底部/面板列表里就会出现「并发工作区」的图标。

> 也可以直接把这段 `insert` 块粘给 DSH 的包管理器插件，或者让 AI 帮你装。

### 方式二：本地目录（开发用）

仓库已经克隆在本地时，用自带的安装脚本：

```powershell
cd D:\DSHarness\dsh-workspaceManager
node tools/install.mjs --dry-run   # 只看会改什么
node tools/install.mjs             # 真正写入
```

它会做三件事：在 profile 的 `node_modules` 里建一个指向本目录的 junction、在 profile 的 `package.json` 补上 `dependencies` 条目、把 bundle 的 `insert` 行写进 profile 的 `cordis.patch.yml` 的标记块里。**改写的每个文件都会先备份成 `<文件名>.bak-<时间戳>`**；手写的 patch 内容留在标记块外面，不受影响。

```powershell
node tools/install.mjs --uninstall   # 按标记块反向卸载
```

卸载后插件从 Loader 里热移除，工作区管理器自己的记录文件（见下）不会被删。

## 用起来

打开「并发工作区」面板，从上到下三段：

### 1. 仓库

填一次就够：

- **仓库地址**：`git clone` 认的任何写法都可以——`https://…`、`git@…`、本地路径都行。
- **显示名称**：面板里怎么称呼它，也参与目录名模板。
- **默认开发分支**：点「分支」会跑一次 `git ls-remote` 把远端分支列出来给你选，也可以直接手打。
- **克隆父目录**：以后这个仓库的克隆都放这里；留空就用全局默认。

### 2. 新建子工作区

- **仓库**：选一个已登记的，或者选「临时仓库」现填地址。
- **名称**：你给这次改动起的名字，比如 `retry-fix`。它会同时变成工作区标题和目录名的一部分。
- **分支名**：跟着名称自动填，改过之后就不再自动覆盖。留空就用全局的 `branchPrefix + 名称`。
- **目录名 / 父目录**：最终目录是 `<父目录>/<目录名>`。
- **从分支**：显示这次会从哪个分支拉新分支。

点「创建并注册工作区」，面板下方会出现任务条，实时显示 `git clone` / `git fetch` / `git checkout -b` / 注册工作区的进度和日志，可以取消。

### 3. 子工作区

每个子工作区一张卡片：

| 按钮 | 作用 |
| --- | --- |
| **打开会话** | 选中这个工作区并**新建一个会话**，直接进入对话。 |
| **复用空白会话** | 打开这个工作区的空白会话（已有就直接复用）。 |
| **重命名** | 改工作区标题，同时同步给 DSH 的工作区列表。 |
| **在文件夹里打开** | 用系统的文件管理器打开克隆目录。 |
| **归档** | 把工作区从 DSH 的工作区列表里移除。会弹一个确认框，里面可以勾「同时删除本地目录」——默认不勾，因为归档应该是安全的，删目录是另一件事。 |

已归档的卡片会收进「已归档」折叠区，可以「恢复到工作区列表」或「彻底删除记录」。

## 工作区记录存在哪

```
$DSH_HOME/storages/dsh-workspace-manager.json
```

默认是 `C:\Users\<你>\.dsh\storages\dsh-workspace-manager.json`。一个 JSON 文件，写入是「临时文件 + rename」的原子写。文件损坏时会被备份成 `<文件名>.bak-<时间戳>` 再重建，不会直接丢掉。

它只存三样东西：你登记的仓库、子工作区记录、全局设置。**真实的分支和目录状态每次都是从磁盘和 git 现读的**，不会因为记录过期而显示错的东西。

## 配置

`cordis.patch.yml` 里行的 `config` 段全部可选：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultParentDir` | `''` | 克隆的默认父目录；留空用 `$DSH_HOME/workspaces`。 |
| `directoryTemplate` | `'{repo}-{name}'` | 目录名模板，可用 `{repo}` `{name}` `{branch}`。 |
| `branchPrefix` | `''` | 自动生成分支名时的前缀。 |
| `cloneDepth` | `0` | 0 = 完整克隆；正数加 `--depth`。 |
| `partialClone` | `false` | 加 `--filter=blob:none`（`cloneDepth > 0` 时忽略）。 |
| `fetchBeforeCreate` | `true` | 建分支前先 `git fetch origin <基础分支>`。 |
| `deleteDirectoryOnArchive` | `false` | 归档时是否默认勾上「同时删除本地目录」。 |
| `autoOpenSession` | `false` | 创建成功后自动开会话。 |
| `concurrency` | `2` | 同时最多跑几个 git 任务。 |
| `storageFile` | `''` | 覆盖存储文件路径。 |

## 它是怎么接进 DSH 的

插件由两半组成，一个 Loader 行同时注册：

- **Host 半**（`lib/index.js`）：在 `ctx.webServer` 上注册 `POST /workspace-manager/<method>` 路由，通过 `ctx.get('subprocess')` 跑 git，通过 `ctx.get('workspaceRegistry')` 增删 DSH 的工作区注册，并把记录写进上面那个 JSON。
- **浏览器半**（`lib/client.js`）：注册 `sidebar.panellist`（左侧栏图标）和 `main`（面板页，key 为 `workspaceManager`），通过 `ctx.get('uiWorkspace')` 的 `startSession(workspaceId)` 完成「选中工作区 + 建会话」，通过 `ctx.get('workspaces')` 同步标题。

`subprocess` 和 `workspaceRegistry` 都是**可选**能力，用 `ctx.get()` 读。宿主没装这两个服务时插件照样加载，面板会直接告诉你「没找到 git」或「工作区注册服务不可用」，而不是整个挂掉。

完整的线上协议见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 开发

```powershell
node tools/build.mjs          # 构建 lib/（Host 半直拷，浏览器半包进 __ModuleLoader__ 注册）
node tools/build.mjs --check  # 只校验 lib/ 是否与 src/ 一致
node --test "tests/*.test.mjs"
```

改 `src/` 之后必须重新构建——DSH 服务的是 `lib/client.js`，不是源码。

## 已知边界

- **克隆大仓库会慢**：任务条会显示进度，可以随时取消；但取消后已经克隆下来的目录**不会**被自动删掉（不会静默动用户的文件）。
- **不支持 worktree**：这里刻意用「独立克隆」而不是 `git worktree`，因为 DSH 的工作区认的是一个独立的规范目录；worktree 之间共享 `.git` 会让工作区路径语义变复杂。
- **冲突不自动处理**：创建分支时如果目标分支已存在，任务直接失败并把 git 的原始报错贴进日志，不会自动改名或强推。
- **一次只归档，不合并**：插件负责「开分支」和「收工作区」，不管 PR、合并、删远端分支这些事。
- **面板文案目前只有中文**。

## License

MIT
