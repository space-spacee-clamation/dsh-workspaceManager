/**
 * Path arithmetic for the Workspace Manager Host half: where the JSON store
 * lives, where clones land, and how a directory name is derived from the
 * settings template.
 *
 * Every function is pure and takes its environment as an argument, so the
 * layout is testable without touching `process.env` or the real home
 * directory.
 *
 * @module dsh-workspace-manager/host/paths
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

/** Placeholders a directory template may use. */
export const TEMPLATE_KEYS = Object.freeze(['repo', 'name', 'branch'])

/** Characters a template substitution may not contribute to a directory name. */
const SEGMENT_FORBIDDEN = /[\\/:*?"<>|]+/g

/** Control characters dropped from a substituted segment. */
const SEGMENT_CONTROL = /[\u0000-\u001f\u007f]+/g

/**
 * Resolve the DSH home directory: `$DSH_HOME` when set, else `~/.dsh`.
 * @param env - environment to read (defaults to `process.env`).
 * @param home - the user's home directory (defaults to `os.homedir()`).
 * @returns {string} the normalized DSH home.
 */
export function dshHome(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return normalize(configured.length > 0 ? configured : join(home, '.dsh'))
}

/**
 * Resolve the plugin's JSON store file.
 * @param options - `override` (config `storageFile`), `env`, and `home`.
 * @returns {string} the normalized absolute store path.
 */
export function storageFileFor(options = {}) {
  const override = typeof options.override === 'string' ? options.override.trim() : ''
  if (override.length > 0) return normalize(override)
  return join(dshHome(options.env, options.home), 'storages', 'dsh-workspace-manager.json')
}

/**
 * Resolve the fallback clone root (`$DSH_HOME/workspaces`).
 * @param env - environment to read.
 * @param home - the user's home directory.
 * @returns {string} the normalized absolute directory.
 */
export function defaultWorkspacesDir(env = process.env, home = homedir()) {
  return join(dshHome(env, home), 'workspaces')
}

/**
 * Make one template substitution safe for a single path segment.
 * @param value - the substituted value.
 * @returns {string} a separator-free, control-free segment.
 */
export function sanitizeSegment(value) {
  const source = typeof value === 'string' ? value : String(value ?? '')
  return source
    .replace(SEGMENT_CONTROL, '')
    .replace(SEGMENT_FORBIDDEN, '-')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .trim()
}

/**
 * Expand a directory template. Only the documented placeholders are
 * substituted; an unknown `{token}` is left verbatim, and the result still
 * has to pass directory-name validation before it is used.
 * @param template - for example `'{repo}-{name}'`.
 * @param vars - values for {@link TEMPLATE_KEYS}.
 * @returns {string} the expanded, sanitized directory name.
 */
export function applyTemplate(template, vars = {}) {
  const source = typeof template === 'string' && template.trim().length > 0 ? template : '{repo}-{name}'
  const values = typeof vars === 'object' && vars !== null ? vars : {}
  return source.replace(/\{(\w+)\}/g, (match, key) => (
    TEMPLATE_KEYS.includes(key) ? sanitizeSegment(values[key]) : match
  ))
}

/**
 * Join a parent directory and one directory name.
 * @param parentDir - absolute parent directory.
 * @param directoryName - single validated directory name.
 * @returns {string} the normalized absolute target directory.
 */
export function joinDirectory(parentDir, directoryName) {
  return normalize(join(parentDir, directoryName))
}

/**
 * @param value - candidate directory.
 * @returns {boolean} whether it currently exists and is a directory.
 */
export function isDirectorySync(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    // A missing, unreadable, or dangling path is simply "not a directory here".
    return false
  }
}

/**
 * Whether a path exists at all (as a file or a directory).
 * @param value - candidate path.
 * @returns {boolean} whether the filesystem holds an entry there.
 */
export function pathExistsSync(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  return existsSync(value)
}

/**
 * Whether an existing directory holds anything at all. `git clone` accepts an
 * existing but empty directory, so the create flow only refuses a non-empty
 * one.
 * @param value - candidate directory.
 * @returns {boolean} whether it is a directory with no entries.
 */
export function isEmptyDirectory(value) {
  if (!isDirectorySync(value)) return false
  try {
    return readdirSync(value).length === 0
  } catch {
    // An unreadable directory is treated as occupied: refusing is the safe direction.
    return false
  }
}
