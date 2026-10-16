/**
 * The background job runner of the Workspace Manager Host half.
 *
 * `workspaces/create`, `workspaces/archive`, and `workspaces/forget` answer
 * with a `Job` immediately; the clone, branch, registration, and persistence
 * work continues here, respecting the configured concurrency limit. Each job
 * reports short Chinese steps and bounded log lines so the panel shows real
 * progress, and `jobs/cancel` aborts the job's `AbortSignal`, which the git
 * runner hands straight to `subprocess.spawn`, terminating the running child.
 *
 * A job is the only failure channel for the three job-starting methods, so a
 * settled failure also carries the stable `workspace-manager/*` `code` beside
 * the localized `error` text: a client branches on the discriminant instead of
 * reading Chinese prose. `code` is `null` while the job is running, when it
 * succeeded, and when it was cancelled.
 *
 * At most {@link MAX_JOBS} jobs are retained, newest first. A running job is
 * never evicted, so the client can always see what is still happening.
 *
 * @module dsh-workspace-manager/host/manager
 */

import { CODES, fail, isWorkspaceManagerError, message } from './errors.js'
import { newId, nowIso } from './ids.js'

/** Most jobs retained in memory. */
export const MAX_JOBS = 50

/** Most jobs waiting for a concurrency slot before `busy` is answered. */
export const MAX_PENDING_JOBS = 16

/** Most log entries retained per job. */
export const MAX_JOB_LOG = 200

/** Longest single log line retained. */
export const MAX_LOG_TEXT = 500

/**
 * One job's mutable record.
 * @typedef {object} JobRecord
 * @property {string} id
 * @property {'create' | 'archive'} kind
 * @property {string} label
 * @property {'running' | 'ok' | 'failed' | 'cancelled'} status
 * @property {string} step
 * @property {number} progress
 * @property {object[]} log
 * @property {string} startedAt
 * @property {string | null} endedAt
 * @property {string | null} error
 * @property {string | null} code
 * @property {string | null} resultId
 * @property {boolean} cancelled
 * @property {AbortController} controller
 * @property {Function} task
 */

/**
 * Create the job runner.
 * @param options - `concurrency` (a positive integer or a getter, so a
 * settings change takes effect immediately) and an optional `logger`.
 * @returns {{
 *   start: (input: object) => object,
 *   list: () => object[],
 *   cancel: (id: string) => boolean,
 *   pump: () => void,
 *   close: () => void,
 *   readonly busy: boolean,
 * }} the runner handle.
 */
export function createJobRunner(options = {}) {
  const logger = options.logger
  const onSettle = typeof options.onSettle === 'function' ? options.onSettle : () => {}
  const configured = options.concurrency
  const concurrencyOf = typeof configured === 'function'
    ? configured
    : () => (Number.isInteger(configured) && configured > 0 ? configured : 2)

  /** @type {JobRecord[]} every retained job, oldest first. */
  const records = []
  /** @type {JobRecord[]} jobs waiting for a concurrency slot, in submission order. */
  const queue = []
  let running = 0
  let closed = false

  /** @returns {number} the currently configured concurrency limit. */
  function limit() {
    const value = concurrencyOf()
    return Number.isInteger(value) && value > 0 ? value : 2
  }

  /** Drop the oldest settled jobs once the retention bound is exceeded. */
  function trim() {
    while (records.length > MAX_JOBS) {
      const index = records.findIndex((record) => record.status !== 'running')
      if (index < 0) return
      records.splice(index, 1)
    }
  }

  /**
   * Append one bounded log line.
   * @param record - the job record.
   * @param level - `info`, `warn`, or `error`.
   * @param text - the line; whitespace runs collapse so a `\r` progress burst stays one line.
   */
  function appendLog(record, level, text) {
    const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
    if (line.length === 0) return
    record.log.push({
      at: nowIso(),
      level: level === 'warn' || level === 'error' ? level : 'info',
      text: line.length > MAX_LOG_TEXT ? line.slice(0, MAX_LOG_TEXT) : line,
    })
    if (record.log.length > MAX_JOB_LOG) record.log.splice(0, record.log.length - MAX_JOB_LOG)
  }

  /**
   * Project one record into the wire `Job`.
   * @param record - the job record.
   * @returns {object} a detached copy.
   */
  function snapshot(record) {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      status: record.status,
      step: record.step,
      progress: record.progress,
      log: record.log.map((entry) => ({ ...entry })),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      error: record.error,
      code: record.code,
      resultId: record.resultId,
    }
  }

  /**
   * Finish one job.
   * @param record - the job record.
   * @param status - the terminal status.
   * @param errorText - failure text, when the status is `failed`.
   * @param code - the stable `workspace-manager/*` discriminant of that
   * failure. A failed job always carries one, so a caller that somehow reports
   * a failure without a code gets the unexpected-failure discriminant rather
   * than a `null` a client would have to interpret.
   */
  function settle(record, status, errorText, code = null) {
    record.status = status
    record.endedAt = nowIso()
    record.error = status === 'failed' ? (errorText ?? '未知错误') : null
    record.code = status === 'failed'
      ? (typeof code === 'string' && code.length > 0 ? code : CODES.unsupported)
      : null
    if (status === 'ok') record.progress = 1
    record.step = status === 'ok' ? '已完成' : status === 'cancelled' ? '已取消' : '失败'
    trim()
    try {
      onSettle(snapshot(record))
    } catch (error) {
      logger?.warn?.(`workspace-manager: 通知任务变化失败：${message(error)}`)
    }
  }

  /** Start queued jobs while a slot is free. */
  function pump() {
    while (!closed && running < limit() && queue.length > 0) {
      const record = queue.shift()
      if (record === undefined || record.status !== 'running') continue
      running += 1
      void execute(record).finally(() => {
        running -= 1
        pump()
      })
    }
  }

  /**
   * Run one job's task and settle it.
   * @param record - the job record.
   */
  async function execute(record) {
    const context = {
      id: record.id,
      signal: record.controller.signal,
      log: (level, text) => appendLog(record, level, text),
      step: (text, progress) => {
        if (typeof text === 'string' && text.length > 0) record.step = text
        if (typeof progress === 'number') record.progress = progress
      },
      setResultId: (value) => {
        record.resultId = typeof value === 'string' && value.length > 0 ? value : null
      },
    }
    try {
      const produced = await record.task(context)
      if (record.cancelled) {
        settle(record, 'cancelled')
        return
      }
      if (typeof produced === 'string' && produced.length > 0) record.resultId = produced
      settle(record, 'ok')
    } catch (error) {
      const detail = isWorkspaceManagerError(error) ? error.message : message(error)
      const code = isWorkspaceManagerError(error) ? error.code : CODES.unsupported
      if (record.cancelled) {
        appendLog(record, 'warn', '任务已取消')
        settle(record, 'cancelled')
        return
      }
      logger?.warn?.(`workspace-manager: 任务 ${record.id} 失败（${code}）：${detail}`)
      appendLog(record, 'error', detail)
      settle(record, 'failed', detail, code)
    }
  }

  return {
    /**
     * Queue one job and answer with its first snapshot.
     * @param input - `kind` (`create`/`archive`), `label`, and the async `task(context)`.
     * @returns {object} the initial `Job`.
     * @throws {import('./errors.js').WorkspaceManagerError} `busy` when the queue is full, `unsupported` after close.
     */
    start(input = {}) {
      if (closed) throw fail(CODES.unsupported, '工作区管理器正在关闭，无法启动新任务')
      if (queue.length >= MAX_PENDING_JOBS) {
        throw fail(CODES.busy, `等待中的任务过多（上限 ${MAX_PENDING_JOBS}），请稍后再试`)
      }
      /** @type {JobRecord} */
      const record = {
        id: newId('job'),
        kind: input.kind === 'create' ? 'create' : 'archive',
        label: typeof input.label === 'string' ? input.label : '',
        status: 'running',
        step: '排队中',
        progress: -1,
        log: [],
        startedAt: nowIso(),
        endedAt: null,
        error: null,
        code: null,
        resultId: null,
        cancelled: false,
        controller: new AbortController(),
        task: typeof input.task === 'function' ? input.task : async () => null,
      }
      records.push(record)
      queue.push(record)
      trim()
      pump()
      return snapshot(record)
    },

    /**
     * @returns {object[]} every retained job, newest first.
     */
    list() {
      return records.slice().reverse().map(snapshot)
    },

    /**
     * Cancel one job: a queued job settles at once, a running job aborts its
     * signal so the child process is terminated by the subprocess provider.
     * @param id - the job id.
     * @returns {boolean} whether the job was still running.
     * @throws {import('./errors.js').WorkspaceManagerError} `not-found`.
     */
    cancel(id) {
      const record = records.find((entry) => entry.id === id)
      if (record === undefined) throw fail(CODES.notFound, `找不到任务：${id}`)
      if (record.status !== 'running') return false
      record.cancelled = true
      const queuedAt = queue.indexOf(record)
      if (queuedAt >= 0) {
        queue.splice(queuedAt, 1)
        appendLog(record, 'warn', '任务在开始前被取消')
        settle(record, 'cancelled')
        return true
      }
      record.controller.abort()
      record.step = '正在取消'
      record.progress = -1
      appendLog(record, 'warn', '已请求取消，正在终止 git 进程')
      return true
    },

    /** Start any queued job a now-larger concurrency limit allows. */
    pump,

    /** Cancel everything still queued or running; used at plugin disposal. */
    close() {
      closed = true
      for (const record of queue.splice(0, queue.length)) {
        record.cancelled = true
        appendLog(record, 'warn', '管理器关闭，任务已取消')
        settle(record, 'cancelled')
      }
      for (const record of records) {
        if (record.status !== 'running') continue
        record.cancelled = true
        record.controller.abort()
        appendLog(record, 'warn', '管理器关闭，正在终止 git 进程')
      }
    },

    /** @returns {boolean} whether another job would be refused as `busy`. */
    get busy() {
      return queue.length >= MAX_PENDING_JOBS
    },
  }
}
