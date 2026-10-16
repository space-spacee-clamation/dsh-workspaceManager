/**
 * The durable record store of the Workspace Manager Host half.
 *
 * One JSON document (`{ version, repos, items, settings }`) holds every repo
 * preset and every managed sub-workspace. Reads never fail: a missing file is
 * an empty store, and a malformed file is backed up to `<file>.bak-<stamp>`
 * and then treated as empty, so a hand-edited file can never wedge the panel.
 * Writes are atomic (temp file plus rename) and never reject either — a
 * failure is recorded as `writeError`, which the caller surfaces through
 * `state.stores` and turns into `workspace-manager/storage-failed` on a write
 * path that promised durability.
 *
 * @module dsh-workspace-manager/host/store
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { message } from './errors.js'
import {
  DEFAULT_SETTINGS, asObject, boundedText, docId, isoInstant, nullableId, normalizeSettings,
} from './validate.js'

/** Version of the persisted document. */
export const STORE_VERSION = 1

/** Upper bounds keeping one hand-edited file from growing without limit. */
export const STORE_LIMITS = Object.freeze({ repos: 200, items: 500 })

/** Counter making a concurrent temp file name unique inside one process. */
let tempCounter = 0

/**
 * @returns {{version: number, repos: object[], items: object[], settings: object}} an empty document.
 */
export function emptyDocument() {
  return { version: STORE_VERSION, repos: [], items: [], settings: { ...DEFAULT_SETTINGS } }
}

/**
 * Coerce one stored repo record.
 * @param raw - candidate record.
 * @returns {object | undefined} the normalized `Repo`, or `undefined` when it carries no usable identity.
 */
export function normalizeRepo(raw) {
  const value = asObject(raw)
  const id = docId(value.id)
  const url = boundedText(value.url, 2000).trim()
  if (id.length === 0 || url.length === 0) return undefined
  const createdAt = isoInstant(value.createdAt, new Date().toISOString())
  const parentDir = boundedText(value.parentDir, 1000).trim()
  return {
    id,
    name: boundedText(value.name, 200).trim() || id,
    url,
    baseBranch: boundedText(value.baseBranch, 200).trim(),
    parentDir,
    createdAt,
    updatedAt: isoInstant(value.updatedAt, createdAt),
  }
}

/**
 * Coerce one stored workspace record. `status` is deliberately dropped: it is
 * observed lazily and never persisted.
 * @param raw - candidate record.
 * @returns {object | undefined} the normalized `WorkspaceItem`, or `undefined` when it carries no identity.
 */
export function normalizeItem(raw) {
  const value = asObject(raw)
  const id = docId(value.id)
  const path = boundedText(value.path, 1000).trim()
  if (id.length === 0 || path.length === 0) return undefined
  const createdAt = isoInstant(value.createdAt, new Date().toISOString())
  const archived = value.archived === true
  const name = boundedText(value.name, 200).trim() || id
  return {
    id,
    workspaceId: nullableId(value.workspaceId),
    name,
    title: boundedText(value.title, 200).trim() || name,
    path,
    repoId: nullableId(value.repoId),
    repoName: boundedText(value.repoName, 200).trim(),
    repoUrl: boundedText(value.repoUrl, 2000).trim(),
    baseBranch: boundedText(value.baseBranch, 200).trim(),
    branch: boundedText(value.branch, 200).trim(),
    archived,
    createdAt,
    updatedAt: isoInstant(value.updatedAt, createdAt),
    archivedAt: archived ? isoInstant(value.archivedAt, createdAt) : null,
  }
}

/**
 * Coerce a whole document, dropping records without identity and de-duplicating
 * by id (the first record wins, so a duplicated line cannot shadow a live one).
 * @param raw - candidate document.
 * @param fallback - document supplying defaults for absent members.
 * @returns {{version: number, repos: object[], items: object[], settings: object}} a complete document.
 */
export function normalizeDocument(raw, fallback = emptyDocument()) {
  const source = asObject(raw)
  const settings = normalizeSettings(source.settings, asObject(fallback).settings ?? DEFAULT_SETTINGS)
  return {
    version: STORE_VERSION,
    repos: dedupe(toRecords(source.repos, normalizeRepo), STORE_LIMITS.repos),
    items: dedupe(toRecords(source.items, normalizeItem), STORE_LIMITS.items),
    settings,
  }
}

/**
 * Map a stored array through one normalizer.
 * @param value - candidate array.
 * @param normalize - per-record coercion.
 * @returns {object[]} the usable records.
 */
function toRecords(value, normalize) {
  if (!Array.isArray(value)) return []
  const records = []
  for (const entry of value) {
    const record = normalize(entry)
    if (record !== undefined) records.push(record)
  }
  return records
}

/**
 * Drop repeated ids and cap the list length.
 * @param records - normalized records.
 * @param limit - maximum retained records.
 * @returns {object[]} the de-duplicated, bounded list.
 */
function dedupe(records, limit) {
  const seen = new Set()
  const kept = []
  for (const record of records) {
    const id = String(record.id)
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(record)
    if (kept.length >= limit) break
  }
  return kept
}

/**
 * Write one file atomically: a sibling temp file is filled and then renamed
 * over the target, so a reader never observes a half-written document.
 * @param file - absolute target path.
 * @param text - complete file contents.
 * @throws when the directory, temp write, or rename fails.
 */
function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  tempCounter += 1
  const temp = `${file}.tmp-${process.pid}-${tempCounter}`
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch (cleanupError) {
      // The rename already failed; a leftover temp file is noise, not the report.
      void cleanupError
    }
    throw error
  }
}

/**
 * Open (or create in memory) the one JSON store of this plugin instance.
 * @param options - `file` (absolute store path) and an optional `logger`.
 * @returns {{
 *   readonly file: string,
 *   readonly writeError: string | null,
 *   readonly fresh: boolean,
 *   ensureLoaded: () => object,
 *   reload: () => object,
 *   read: () => object,
 *   write: (next: object) => boolean,
 * }} the store handle.
 */
export function createStore(options = {}) {
  const file = typeof options.file === 'string' && options.file.length > 0 ? options.file : ''
  const logger = options.logger
  let document = emptyDocument()
  let loaded = false
  let writeError = null
  let fresh = false

  /**
   * Read and normalize the store file once. A missing file is an empty store;
   * a malformed one is backed up and then treated as empty.
   * @returns {object} the loaded document.
   */
  function ensureLoaded() {
    if (loaded) return document
    loaded = true
    fresh = false
    if (file.length === 0) {
      writeError = '存储文件路径为空'
      fresh = true
      return document
    }
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (asObject(error).code !== 'ENOENT') {
        writeError = message(error)
        logger?.warn?.(`workspace-manager: 读取存储失败：${message(error)}`)
      } else {
        fresh = true
      }
      document = emptyDocument()
      return document
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      fresh = true
      try {
        copyFileSync(file, backup)
        logger?.warn?.(`workspace-manager: 存储文件不是合法 JSON（${message(error)}），已备份到 ${backup}，并以空存储启动`)
      } catch (copyError) {
        logger?.warn?.(`workspace-manager: 存储文件不是合法 JSON 且备份失败：${message(copyError)}`)
      }
      document = emptyDocument()
      return document
    }
    document = normalizeDocument(parsed)
    return document
  }

  return {
    /** @returns {string} the absolute JSON store path. */
    get file() {
      return file
    },

    /** @returns {string | null} the last read/write failure, cleared by a successful write. */
    get writeError() {
      return writeError
    },

    /** @returns {boolean} whether the last load found no usable file (missing, empty path, or malformed). */
    get fresh() {
      return fresh
    },

    /**
     * @returns {object} the loaded document (lazily, on first access).
     */
    ensureLoaded,

    /**
     * Re-read the file from disk, discarding the cached document. A second
     * core built over the same file uses this to see the first core's writes;
     * commit points always persist before publishing, so nothing is lost.
     * @returns {object} the reloaded document.
     */
    reload() {
      loaded = false
      return ensureLoaded()
    },

    /**
     * @returns {{version: number, repos: object[], items: object[], settings: object}} a detached copy of the document.
     */
    read() {
      const current = ensureLoaded()
      return {
        version: current.version,
        repos: current.repos.map((repo) => ({ ...repo })),
        items: current.items.map((item) => ({ ...item })),
        settings: { ...current.settings },
      }
    },

    /**
     * Persist a complete document atomically. Never throws: a failure is
     * recorded as {@link createStore.writeError} and reported by the return.
     * @param next - the document to persist; it is normalized before writing.
     * @returns {boolean} whether the document was committed.
     */
    write(next) {
      const normalized = normalizeDocument(next, ensureLoaded())
      try {
        atomicWrite(file, `${JSON.stringify(normalized, null, 2)}\n`)
      } catch (error) {
        writeError = message(error)
        logger?.warn?.(`workspace-manager: 写入存储失败：${message(error)}`)
        return false
      }
      document = normalized
      writeError = null
      return true
    },
  }
}
