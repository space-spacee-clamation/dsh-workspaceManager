/**
 * The git engine of the Workspace Manager Host half.
 *
 * Every command goes through the injected `subprocess` Service Definition —
 * `resolveExecutable('git')` once, then `spawn()` with bounded collect-mode
 * stdio and the caller's AbortSignal. Output is read back with the
 * offset-based `collected.stdout.readFrom(0)`, so a runaway command can never
 * buffer unbounded memory, and a long clone streams its stderr lines to the
 * job log while it runs.
 *
 * A non-zero exit becomes `workspace-manager/git-failed` with the stderr tail
 * in `details.stderr`; `observe()` is the one best-effort method and never
 * throws.
 *
 * @module dsh-workspace-manager/host/git
 */

import { homedir } from 'node:os'
import { dirname } from 'node:path'

import { CODES, fail, isWorkspaceManagerError, message } from './errors.js'
import { isDirectorySync } from './paths.js'
import { tail } from './validate.js'

/** SIGTERM→SIGKILL grace handed to every spawn. */
export const GIT_GRACE_MS = 3_000

/** In-memory cap for one command's stdout. */
export const GIT_STDOUT_BYTES = 1_000_000

/** In-memory cap for one command's stderr. */
export const GIT_STDERR_BYTES = 256_000

/** Characters of stderr retained in `details.stderr`. */
export const GIT_ERROR_TAIL = 4_000

/** How often a streaming command's stderr is drained into the job log. */
export const GIT_PROGRESS_POLL_MS = 250

/** Most lines forwarded per drain, bounding a burst of progress updates. */
export const GIT_PROGRESS_LINES = 8

/** While git cannot be resolved, later calls reuse the failure for this long. */
export const GIT_RETRY_MS = 5_000

/**
 * The subprocess service this runner consumes, read through the plugin's own
 * `ctx.get` indirection so a profile without the capability still loads.
 * @typedef {() => object | undefined} GetSubprocess
 */

/**
 * Create the git runner.
 * @param options - `getSubprocess` (a `ctx.get('subprocess')` indirection) and an optional `logger`.
 * @returns {{
 *   info: () => Promise<{path: string | null, version: string | null}>,
 *   run: (argv: string[], options?: object) => Promise<{stdout: string, stderr: string, exitCode: number}>,
 *   lsRemote: (url: string, options?: object) => Promise<{branches: string[], head: string | null}>,
 *   clone: (url: string, dir: string, options?: object) => Promise<object>,
 *   createBranch: (dir: string, branch: string, base: string, options?: object) => Promise<object>,
 *   observe: (dir: string) => Promise<object>,
 * }} the runner handle.
 */
export function createGitRunner(options = {}) {
  const getSubprocess = typeof options.getSubprocess === 'function' ? options.getSubprocess : () => undefined
  const logger = options.logger
  let executablePromise = null
  let executableVersion = null
  let unavailable = null
  let warnedMissing = false

  /** @returns {object | undefined} the composed subprocess service, when there is one. */
  function subprocessOf() {
    const subprocess = getSubprocess()
    return subprocess === undefined || subprocess === null ? undefined : subprocess
  }

  /** @returns {string} a directory that exists for commands needing no project directory. */
  function fallbackCwd() {
    try {
      return process.cwd()
    } catch (error) {
      // A deleted working directory is survivable: the home directory always exists.
      void error
      return homedir()
    }
  }

  /**
   * Resolve the git executable once, caching both the success and (briefly)
   * the failure so a missing capability does not retry on every panel read.
   * @returns {Promise<string>} the executable path.
   * @throws {import('./errors.js').WorkspaceManagerError} `no-git`.
   */
  async function requireExecutable() {
    if (executablePromise !== null) return await executablePromise
    if (unavailable !== null && Date.now() - unavailable.at < GIT_RETRY_MS) throw unavailable.error
    const subprocess = subprocessOf()
    if (subprocess === undefined || typeof subprocess.resolveExecutable !== 'function') {
      const error = fail(CODES.noGit, '此 Host 没有提供 subprocess 能力，无法运行 git')
      unavailable = { at: Date.now(), error }
      throw error
    }
    const attempt = (async () => {
      const resolved = await subprocess.resolveExecutable('git')
      if (typeof resolved !== 'string' || resolved.trim().length === 0) {
        throw fail(CODES.noGit, '未能在此 Host 的执行环境中解析到 git')
      }
      return resolved
    })()
    executablePromise = attempt
    try {
      const executable = await attempt
      unavailable = null
      return executable
    } catch (error) {
      // The capability may be composed later, so the next call retries instead of failing forever.
      executablePromise = null
      const failure = isWorkspaceManagerError(error)
        ? error
        : fail(CODES.noGit, `未能在此 Host 的执行环境中解析到 git：${message(error)}`)
      unavailable = { at: Date.now(), error: failure }
      throw failure
    }
  }

  /**
   * Read one collected stream's tail.
   * @param handle - the live subprocess handle.
   * @param stream - `stdout` or `stderr`.
   * @returns {string} the captured text, or `''` when the stream is unavailable.
   */
  function readCollected(handle, stream) {
    const reader = handle?.collected?.[stream]
    if (reader === undefined || typeof reader.readFrom !== 'function') return ''
    try {
      const read = reader.readFrom(0)
      return typeof read?.text === 'string' ? read.text : ''
    } catch (error) {
      // A provider that already closed its collector must not turn a finished command into a failure.
      logger?.warn?.(`workspace-manager: 读取 git ${stream} 输出失败：${message(error)}`)
      return ''
    }
  }

  /**
   * Drain a still-running command's stderr into the job log.
   * @param handle - the live subprocess handle.
   * @param onLine - receives every new non-empty line.
   * @returns {{flush: () => void, stop: () => void}} the pump controls.
   */
  function startPump(handle, onLine) {
    let offset = 0
    let previous = ''
    /** Read whatever arrived since the last tick. */
    const tick = () => {
      const reader = handle?.collected?.stderr
      if (reader === undefined || typeof reader.readFrom !== 'function') return
      let read
      try {
        read = reader.readFrom(offset)
      } catch (error) {
        // Streaming diagnostics are the lowest-value part of a command: a closed collector just ends them.
        void error
        return
      }
      if (typeof read?.nextOffset === 'number') offset = read.nextOffset
      const text = typeof read?.text === 'string' ? read.text : ''
      if (text.length === 0) return
      const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line.length > 0)
      for (const line of lines.slice(-GIT_PROGRESS_LINES)) {
        if (line === previous) continue
        previous = line
        try {
          onLine(line)
        } catch (error) {
          logger?.warn?.(`workspace-manager: 记录 git 输出失败：${message(error)}`)
        }
      }
    }
    const timer = setInterval(tick, GIT_PROGRESS_POLL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return { flush: tick, stop: () => clearInterval(timer) }
  }

  /**
   * Build the one failure shape every command uses. The surfaced line is
   * git's own diagnostic (`fatal:` / `error:`), which names the cause; the
   * prose git prints after it ("and the repository exists.") is a hint for a
   * human reading the full stream, not a diagnosis.
   * @param argv - the git arguments (without the executable).
   * @param summary - localized one-line summary.
   * @param stderr - captured stderr.
   * @returns {import('./errors.js').WorkspaceManagerError} `git-failed`.
   */
  function gitFailure(argv, summary, stderr) {
    const detail = tail(typeof stderr === 'string' ? stderr : '', GIT_ERROR_TAIL)
    const line = diagnosticLine(detail)
    return fail(
      CODES.gitFailed,
      line === undefined ? summary : `${summary}：${line}`,
      { argv: ['git', ...argv], stderr: detail },
    )
  }

  /**
   * @param outcome - the settled subprocess outcome.
   * @returns {number | null} the exit code, `null` when a signal ended the process.
   */
  function exitCodeOf(outcome) {
    if (outcome === undefined || outcome === null) return 0
    if (typeof outcome.exitCode === 'number') return outcome.exitCode
    if (outcome.exitCode === null) return null
    return typeof outcome.code === 'number' ? outcome.code : 0
  }

  /**
   * Run one git command to completion.
   * @param argv - git arguments; `argv[0]` is the subcommand.
   * @param options - `cwd`, `signal` (the job's cancellation), and `onStderrLine` for live output.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>} the captured result.
   * @throws {import('./errors.js').WorkspaceManagerError} `no-git` or `git-failed`.
   */
  async function run(argv, options = {}) {
    const executable = await requireExecutable()
    const subprocess = subprocessOf()
    if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
      throw fail(CODES.noGit, '此 Host 没有提供 subprocess 能力，无法运行 git')
    }
    const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : fallbackCwd()
    const signal = options.signal
    if (signal?.aborted === true) {
      throw fail(CODES.gitFailed, `git ${argv[0] ?? ''} 已取消`, { argv: ['git', ...argv], stderr: '' })
    }
    let handle
    try {
      handle = subprocess.spawn({
        argv: [executable, ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: GIT_STDOUT_BYTES },
          stderr: { maxBytes: GIT_STDERR_BYTES },
        },
        graceMs: GIT_GRACE_MS,
        signal,
      })
    } catch (error) {
      throw gitFailure(argv, `无法启动 git ${argv[0] ?? ''}`, message(error))
    }
    const pump = typeof options.onStderrLine === 'function' ? startPump(handle, options.onStderrLine) : undefined
    let outcome
    try {
      outcome = await (handle?.done ?? Promise.resolve({ exitCode: 0, signal: null }))
    } catch (error) {
      pump?.stop()
      throw gitFailure(argv, `git ${argv[0] ?? ''} 进程异常结束`, readCollected(handle, 'stderr') || message(error))
    }
    pump?.flush()
    pump?.stop()
    const stdout = readCollected(handle, 'stdout')
    const stderr = readCollected(handle, 'stderr')
    const exitCode = exitCodeOf(outcome)
    if (exitCode !== 0) {
      if (signal?.aborted === true) {
        throw fail(CODES.gitFailed, `git ${argv[0] ?? ''} 已取消`, { argv: ['git', ...argv], stderr: tail(stderr, GIT_ERROR_TAIL) })
      }
      const ended = exitCode === null ? '进程被信号终止' : `退出码 ${exitCode}`
      throw gitFailure(argv, `git ${argv[0] ?? ''} 失败（${ended}）`, stderr)
    }
    return { stdout, stderr, exitCode: 0 }
  }

  /**
   * Executable path and version for `state.stores`; never throws.
   * @returns {Promise<{path: string | null, version: string | null}>} the resolved facts, or nulls.
   */
  async function info() {
    try {
      const executable = await requireExecutable()
      if (executableVersion === null) {
        try {
          const result = await run(['--version'], { cwd: fallbackCwd() })
          executableVersion = parseVersion(result.stdout)
        } catch (error) {
          logger?.warn?.(`workspace-manager: 读取 git 版本失败：${message(error)}`)
        }
      }
      return { path: executable, version: executableVersion }
    } catch (error) {
      if (!warnedMissing) {
        warnedMissing = true
        logger?.warn?.(`workspace-manager: ${message(error)}`)
      }
      return { path: null, version: null }
    }
  }

  /**
   * List a remote's branches and its default branch.
   * @param url - remote URL or local path accepted by `git ls-remote`.
   * @param options - `signal`.
   * @returns {Promise<{branches: string[], head: string | null}>} the branches in remote order and the default branch.
   * @throws {import('./errors.js').WorkspaceManagerError} `git-failed` when the heads listing fails.
   */
  async function lsRemote(url, options = {}) {
    const target = typeof url === 'string' ? url.trim() : ''
    if (target.length === 0) throw fail(CODES.badRequest, 'url 不能为空')
    const cwd = fallbackCwd()
    const [symref, heads] = await Promise.allSettled([
      run(['ls-remote', '--symref', target, 'HEAD'], { cwd, signal: options.signal }),
      run(['ls-remote', '--heads', target], { cwd, signal: options.signal }),
    ])
    if (heads.status === 'rejected') throw heads.reason
    const branches = []
    for (const line of heads.value.stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const ref = line.slice(tab + 1).trim()
      if (!ref.startsWith('refs/heads/')) continue
      const name = ref.slice('refs/heads/'.length)
      if (name.length > 0 && !branches.includes(name)) branches.push(name)
    }
    const head = symref.status === 'fulfilled' ? parseSymref(symref.value.stdout) : null
    if (symref.status === 'rejected') {
      logger?.warn?.(`workspace-manager: 读取默认分支失败，将只返回分支列表：${message(symref.reason)}`)
    }
    return { branches, head }
  }

  /**
   * Clone a remote into a new directory.
   * @param url - remote URL or local path.
   * @param dir - absolute target directory (its parent must exist).
   * @param options - `depth`, `partial`, `base`, `signal`, and `onLine` for streamed stderr.
   * @returns {Promise<object>} the captured command result.
   * @throws {import('./errors.js').WorkspaceManagerError} `git-failed`.
   */
  async function clone(url, dir, options = {}) {
    const argv = ['clone']
    const depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : 0
    if (depth > 0) argv.push('--depth', String(depth))
    else if (options.partial === true) argv.push('--filter=blob:none')
    if (typeof options.base === 'string' && options.base.length > 0) argv.push('--branch', options.base)
    argv.push(url, dir)
    return await run(argv, {
      cwd: dirname(dir),
      signal: options.signal,
      onStderrLine: options.onLine,
    })
  }

  /**
   * Create the work branch. The remote-tracking start point is preferred after
   * a `fetch origin <base>`; a plain local `<base>` is the fallback for a repo
   * with no `origin` remote (or a base that only exists locally).
   * @param dir - the clone directory.
   * @param branch - the new branch name.
   * @param base - the base branch, or `''` to branch off the current HEAD.
   * @param options - `fetch`, `signal`, and `onLine`.
   * @returns {Promise<object>} the captured command result.
   * @throws {import('./errors.js').WorkspaceManagerError} `git-failed` naming every attempt.
   */
  async function createBranch(dir, branch, base, options = {}) {
    const signal = options.signal
    const baseName = typeof base === 'string' ? base.trim() : ''
    if (options.fetch === true && baseName.length > 0) {
      try {
        await run(['-C', dir, 'fetch', 'origin', baseName], { cwd: dir, signal, onStderrLine: options.onLine })
      } catch (error) {
        logger?.warn?.(`workspace-manager: 拉取 origin/${baseName} 失败，改用本地引用：${message(error)}`)
      }
    }
    const starts = baseName.length > 0 ? [`origin/${baseName}`, baseName] : [null]
    const failures = []
    for (const start of starts) {
      const argv = ['-C', dir, 'checkout', '-b', branch]
      if (start !== null) argv.push(start)
      try {
        return await run(argv, { cwd: dir, signal, onStderrLine: options.onLine })
      } catch (error) {
        failures.push(error)
        if (signal?.aborted === true || !isWorkspaceManagerError(error) || error.code !== CODES.gitFailed) throw error
      }
    }
    const detail = failures
      .map((error) => tail(String(error.details?.stderr ?? error.message), GIT_ERROR_TAIL))
      .join('\n')
    const argv = ['-C', dir, 'checkout', '-b', branch]
    if (baseName.length > 0) argv.push(baseName)
    throw gitFailure(argv, `无法创建分支 ${branch}`, detail)
  }

  /**
   * Observe a working directory. Best effort by contract: every failure is
   * reported in `status.error` instead of being thrown.
   * @param dir - the directory to inspect.
   * @returns {Promise<{exists: boolean, branch: string | null, dirty: boolean, ahead: number, behind: number, error: string | null}>} the observation.
   */
  async function observe(dir) {
    const status = { exists: false, branch: null, dirty: false, ahead: -1, behind: -1, error: null }
    try {
      if (!isDirectorySync(dir)) return status
      status.exists = true
      const problems = []
      try {
        const result = await run(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
        const name = result.stdout.trim()
        status.branch = name.length === 0 || name === 'HEAD' ? null : name
      } catch (error) {
        problems.push(message(error))
      }
      try {
        const result = await run(['-C', dir, 'status', '--porcelain'], { cwd: dir })
        status.dirty = result.stdout.trim().length > 0
      } catch (error) {
        problems.push(message(error))
      }
      try {
        const result = await run(['-C', dir, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: dir })
        const [ahead, behind] = result.stdout.trim().split(/\s+/).map((part) => Number.parseInt(part, 10))
        if (Number.isInteger(ahead)) status.ahead = ahead
        if (Number.isInteger(behind)) status.behind = behind
      } catch (error) {
        // A work branch without an upstream is the normal case; -1 already means "unknown".
        void error
      }
      status.error = problems.length > 0 ? problems[0] : null
      return status
    } catch (error) {
      status.error = status.error ?? message(error)
      return status
    }
  }

  return { info, run, lsRemote, clone, createBranch, observe }
}

/**
 * Choose the stderr line worth surfacing to the user. git prints the specific
 * cause first and a generic cascade after it (`fatal: '<path>' does not appear
 * to be a git repository`, then `fatal: Could not read from remote
 * repository.`, then advice prose), so the root cause is the FIRST `fatal:`
 * line — the last one only repeats that the remote could not be read. A
 * command that printed no `fatal:` falls back to its last `error:` line, then
 * to its last non-empty line. `details.stderr` keeps the whole tail, so the
 * surrounding prose is still available to whoever needs it.
 * @param text - the captured stderr tail.
 * @returns {string | undefined} the line to append to the failure message.
 */
function diagnosticLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const fatal = lines.find((line) => /^fatal:/i.test(line))
  if (fatal !== undefined) return fatal
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^error:/i.test(lines[index])) return lines[index]
  }
  return lines[lines.length - 1]
}

/**
 * Parse the default branch out of `git ls-remote --symref <url> HEAD`, whose
 * first line is `ref: refs/heads/<name>\tHEAD`.
 * @param stdout - captured stdout.
 * @returns {string | null} the branch name, or `null` when the remote has no symref HEAD.
 */
function parseSymref(stdout) {
  const match = /^ref:\s+refs\/heads\/([^\t\n]+)\t+HEAD\s*$/m.exec(stdout)
  return match === null ? null : match[1].trim()
}

/**
 * Parse `git --version` output.
 * @param stdout - captured stdout, for example `git version 2.56.0.windows.1`.
 * @returns {string | null} the version text.
 */
function parseVersion(stdout) {
  const match = /git version\s+(\S+)/.exec(stdout)
  if (match !== null) return match[1]
  const trimmed = stdout.trim()
  return trimmed.length > 0 ? tail(trimmed, 60) : null
}
