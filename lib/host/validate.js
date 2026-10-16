/**
 * Boundary validation for the Workspace Manager Host half.
 *
 * Everything crossing the wire, the JSON store, or the loader row is coerced
 * here: a wrong type is either replaced by the documented default (store
 * loads, which must tolerate hand-edited files) or rejected loud with
 * `workspace-manager/bad-request` (requests and settings patches, where the
 * caller can fix the mistake). Branch names, directory names, and absolute
 * paths follow the platform rules of the directory they will be used in, so a
 * separator or a `..` never reaches `git` or `join()`.
 *
 * @module dsh-workspace-manager/host/validate
 */

import { isAbsolute, normalize as normalizePath } from 'node:path'

import { CODES, fail } from './errors.js'

/** Control characters are never valid in a name, a path, or a ref. */
export const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

/** Characters `git check-ref-format` rejects outright (plus whitespace). */
const BRANCH_FORBIDDEN = /[\s~^:?*[\\]/

/** Characters no Windows directory name may carry, and separators everywhere. */
const DIRECTORY_FORBIDDEN = /[\\/:*?"<>|]/

/** Device names Windows still reserves after all these years. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Stored record ids: a slug that is safe in a JSON key and in a log line. */
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** The `Settings` record of `docs/PROTOCOL.md`, with the shipped defaults. */
export const DEFAULT_SETTINGS = Object.freeze({
  defaultParentDir: '',
  directoryTemplate: '{repo}-{name}',
  branchPrefix: '',
  cloneDepth: 0,
  partialClone: false,
  fetchBeforeCreate: true,
  deleteDirectoryOnArchive: false,
  autoOpenSession: false,
  concurrency: 2,
})

/**
 * @param value - candidate payload.
 * @returns {Record<string, unknown>} the value when it is a plain object, else `{}`.
 */
export function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/**
 * @param value - candidate text.
 * @param max - maximum retained length.
 * @returns {string} the text, truncated to `max`; `''` for a non-string.
 */
export function boundedText(value, max) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Require a non-empty, bounded string.
 * @param value - candidate text.
 * @param max - maximum accepted length.
 * @param field - field name used in the diagnostic.
 * @returns {string} the trimmed text.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` when it is not a usable string.
 */
export function requireText(value, max, field) {
  if (typeof value !== 'string') throw fail(CODES.badRequest, `${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw fail(CODES.badRequest, `${field} 不能为空`)
  if (trimmed.length > max) throw fail(CODES.badRequest, `${field} 过长（上限 ${max} 字符）`)
  return trimmed
}

/**
 * Accept an absent value, but reject a present one of the wrong type.
 * @param value - candidate text, or `undefined`/`null`/`''`.
 * @param max - maximum accepted length.
 * @param field - field name used in the diagnostic.
 * @returns {string} the trimmed text, or `''` when absent.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on a wrong type or an over-long value.
 */
export function optionalText(value, max, field) {
  if (value === undefined || value === null || value === '') return ''
  return requireText(value, max, field)
}

/**
 * Accept an absent boolean, but reject a present non-boolean.
 * @param value - candidate flag.
 * @param field - field name used in the diagnostic.
 * @param fallback - value used when absent.
 * @returns {boolean} the flag.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on a wrong type.
 */
export function booleanOf(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw fail(CODES.badRequest, `${field} 必须是布尔值`)
  return value
}

/**
 * Accept an absent integer, but reject a present non-integer or out-of-range one.
 * @param value - candidate count.
 * @param field - field name used in the diagnostic.
 * @param fallback - value used when absent.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns {number} the integer.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on a wrong type or range.
 */
export function integerOf(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw fail(CODES.badRequest, `${field} 必须是整数`)
  }
  if (value < min || value > max) {
    throw fail(CODES.badRequest, `${field} 必须在 ${min}..${max} 之间`)
  }
  return value
}

/**
 * Validate a user-given short name. It is interpolated into a directory name
 * and into a derived branch name, so separators and relative segments are
 * rejected here rather than sanitized silently.
 * @param value - candidate name.
 * @param field - field name used in the diagnostic.
 * @returns {string} the trimmed name.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on an unusable name.
 */
export function checkName(value, field) {
  const name = requireText(value, 100, field)
  if (CONTROL_PATTERN.test(name)) throw fail(CODES.badRequest, `${field} 不能包含控制字符`)
  if (name === '.' || name === '..') throw fail(CODES.badRequest, `${field} 不能是 "." 或 ".."`)
  if (/[\\/]/.test(name)) throw fail(CODES.badRequest, `${field} 不能包含路径分隔符`)
  return name
}

/**
 * Validate a git branch name against the rules `git check-ref-format` enforces
 * for a ref that must also be a valid refname: no whitespace, no
 * `~^:?*[\`, no `..`, no `@{`, no empty or dotted path segment, and no
 * leading dash, dot, or slash.
 * @param value - candidate branch name; `/` is allowed (`feature/x`).
 * @param field - field name used in the diagnostic.
 * @returns {string} the branch name.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on an unusable ref.
 */
export function branchName(value, field) {
  const name = requireText(value, 200, field)
  if (CONTROL_PATTERN.test(name)) throw fail(CODES.badRequest, `${field} 不能包含控制字符`)
  if (BRANCH_FORBIDDEN.test(name)) throw fail(CODES.badRequest, `${field} 含有 git 分支名不允许的字符`)
  if (name.includes('..') || name.includes('@{')) {
    throw fail(CODES.badRequest, `${field} 不能包含 ".." 或 "@{"`)
  }
  if (name.startsWith('-') || name.startsWith('/') || name.startsWith('.')) {
    throw fail(CODES.badRequest, `${field} 不能以 "-"、"/" 或 "." 开头`)
  }
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    throw fail(CODES.badRequest, `${field} 不能以 "/"、"." 或 ".lock" 结尾`)
  }
  if (name === '@') throw fail(CODES.badRequest, `${field} 不能是 "@"`)
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw fail(CODES.badRequest, `${field} 含有空的或相对路径片段`)
  }
  return name
}

/**
 * Validate a branch prefix (for example `feat/`). A trailing slash is the
 * normal shape, so this is looser than {@link branchName}.
 * @param value - candidate prefix; `''` is allowed and means "no prefix".
 * @param field - field name used in the diagnostic.
 * @returns {string} the trimmed prefix.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on an unusable prefix.
 */
export function branchPrefix(value, field) {
  if (typeof value !== 'string') throw fail(CODES.badRequest, `${field} 必须是字符串`)
  const prefix = value.trim()
  if (prefix.length > 100) throw fail(CODES.badRequest, `${field} 过长（上限 100 字符）`)
  if (CONTROL_PATTERN.test(prefix)) throw fail(CODES.badRequest, `${field} 不能包含控制字符`)
  if (BRANCH_FORBIDDEN.test(prefix)) throw fail(CODES.badRequest, `${field} 含有 git 分支名不允许的字符`)
  if (prefix.includes('..') || prefix.includes('@{') || prefix.includes('//')) {
    throw fail(CODES.badRequest, `${field} 不能包含 ".."、"@{" 或 "//"`)
  }
  if (prefix.startsWith('-') || prefix.startsWith('/') || prefix.startsWith('.')) {
    throw fail(CODES.badRequest, `${field} 不能以 "-"、"/" 或 "." 开头`)
  }
  return prefix
}

/**
 * Derive a branch name from the settings prefix plus the user's name. The
 * result is sanitized because the user typed a display name, not a ref; an
 * explicitly typed `branch` goes through {@link branchName} unchanged instead.
 * @param prefix - `settings.branchPrefix`.
 * @param name - the user-given short name.
 * @returns {string} a valid branch name.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` when nothing valid remains.
 */
export function deriveBranch(prefix, name) {
  const cleaned = `${prefix}${name}`
    .replace(/[\s~^:?*[\\\u0000-\u001f\u007f]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-./]+/, '')
    .replace(/[-./]+$/, '')
    .trim()
  if (cleaned.length === 0) {
    throw fail(CODES.badRequest, '无法从名称推导出分支名，请直接填写分支')
  }
  return branchName(cleaned, 'branch')
}

/**
 * Validate a single directory name: no separators, no `..`, nothing Windows
 * would silently strip, and nothing Windows reserves.
 * @param value - candidate directory name.
 * @param field - field name used in the diagnostic.
 * @returns {string} the directory name.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` on an unusable name.
 */
export function checkDirectoryName(value, field) {
  const name = requireText(value, 120, field)
  if (name === '.' || name === '..') throw fail(CODES.badRequest, `${field} 不能是 "." 或 ".."`)
  if (CONTROL_PATTERN.test(name)) throw fail(CODES.badRequest, `${field} 不能包含控制字符`)
  if (DIRECTORY_FORBIDDEN.test(name)) throw fail(CODES.badRequest, `${field} 不能包含 \\ / : * ? " < > |`)
  if (WINDOWS_RESERVED.test(name)) throw fail(CODES.badRequest, `${field} 是系统保留名：${name}`)
  if (/[. ]$/.test(name)) throw fail(CODES.badRequest, `${field} 不能以空格或 "." 结尾`)
  return name
}

/**
 * Require a normalized absolute directory path.
 * @param value - candidate path.
 * @param field - field name used in the diagnostic.
 * @returns {string} the normalized absolute path.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` when it is not absolute.
 */
export function absoluteDir(value, field) {
  const raw = requireText(value, 1000, field)
  if (CONTROL_PATTERN.test(raw)) throw fail(CODES.badRequest, `${field} 不能包含控制字符`)
  if (!isAbsolute(raw)) throw fail(CODES.badRequest, `${field} 必须是绝对路径：${raw}`)
  return normalizePath(raw)
}

/**
 * Normalize a path for comparison: separators unified and a trailing
 * separator removed, so `C:\a\b\` and `C:/a/b` name one directory.
 * @param value - candidate path.
 * @returns {string} the comparable spelling.
 */
export function comparablePath(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const normalized = normalizePath(value)
  return normalized.length > 1 && /[\\/]$/.test(normalized) ? normalized.slice(0, -1) : normalized
}

/**
 * @param value - candidate record id.
 * @returns {string} the id when it is a usable slug, else `''`.
 */
export function docId(value) {
  return typeof value === 'string' && DOC_ID.test(value) ? value : ''
}

/**
 * Derive a record id slug from a display value.
 * @param value - source text, for example a repo name or a URL.
 * @param fallback - id used when nothing usable remains.
 * @returns {string} a slug matching the stored-id rules.
 */
export function slug(value, fallback) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const cleaned = source
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 60)
  return docId(cleaned) || docId(fallback) || ''
}

/**
 * Coerce a stored settings record. In lenient mode (loading a JSON file) a
 * wrong value falls back to the default; in strict mode (a `settings/set`
 * patch) it is a `bad-request`.
 * @param raw - candidate settings, possibly partial.
 * @param base - settings the patch is applied to.
 * @param options - `strict: true` rejects a wrong value instead of ignoring it.
 * @returns {typeof DEFAULT_SETTINGS} a complete settings record.
 * @throws {import('./errors.js').WorkspaceManagerError} `bad-request` in strict mode.
 */
export function normalizeSettings(raw, base = DEFAULT_SETTINGS, options = {}) {
  const strict = options.strict === true
  const source = asObject(raw)
  const next = { ...DEFAULT_SETTINGS, ...base }
  /**
   * Apply one field, swallowing (or rethrowing) its diagnostic.
   * @param key - settings key.
   * @param apply - coercion for the present value.
   */
  const read = (key, apply) => {
    if (source[key] === undefined) return
    try {
      apply(source[key])
    } catch (error) {
      if (strict) throw error
    }
  }

  read('defaultParentDir', (value) => {
    next.defaultParentDir = value === '' ? '' : absoluteDir(value, 'settings.defaultParentDir')
  })
  read('directoryTemplate', (value) => {
    next.directoryTemplate = requireText(value, 200, 'settings.directoryTemplate')
  })
  read('branchPrefix', (value) => {
    next.branchPrefix = branchPrefix(value, 'settings.branchPrefix')
  })
  read('cloneDepth', (value) => {
    next.cloneDepth = integerOf(value, 'settings.cloneDepth', next.cloneDepth, 0, 1000)
  })
  read('partialClone', (value) => {
    next.partialClone = booleanOf(value, 'settings.partialClone', next.partialClone)
  })
  read('fetchBeforeCreate', (value) => {
    next.fetchBeforeCreate = booleanOf(value, 'settings.fetchBeforeCreate', next.fetchBeforeCreate)
  })
  read('deleteDirectoryOnArchive', (value) => {
    next.deleteDirectoryOnArchive = booleanOf(
      value, 'settings.deleteDirectoryOnArchive', next.deleteDirectoryOnArchive,
    )
  })
  read('autoOpenSession', (value) => {
    next.autoOpenSession = booleanOf(value, 'settings.autoOpenSession', next.autoOpenSession)
  })
  read('concurrency', (value) => {
    next.concurrency = integerOf(value, 'settings.concurrency', next.concurrency, 1, 16)
  })
  return next
}

/**
 * Coerce an optional record id (a workspace id or a repo id).
 * @param value - candidate id.
 * @returns {string | null} the trimmed id, or `null` when absent or unusable.
 */
export function nullableId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200 || CONTROL_PATTERN.test(trimmed)) return null
  return trimmed
}

/**
 * Coerce an ISO-8601 instant, falling back when the stored value is unusable.
 * @param value - candidate instant.
 * @param fallback - instant used when absent or unparsable.
 * @returns {string} an ISO-8601 string.
 */
export function isoInstant(value, fallback) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 40) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return fallback
}

/**
 * Truncate a captured stream to its tail, so an error detail stays bounded
 * while keeping the lines a human needs.
 * @param value - captured text.
 * @param max - maximum retained characters.
 * @returns {string} the tail of the text.
 */
export function tail(value, max) {
  const source = typeof value === 'string' ? value : ''
  return source.length > max ? source.slice(source.length - max) : source
}
