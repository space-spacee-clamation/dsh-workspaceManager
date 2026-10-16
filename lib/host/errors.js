/**
 * Error vocabulary of the Workspace Manager Host half.
 *
 * The route answers every dispatch failure with the same JSON error object
 * (`{ code, message, details }`), so `code` is the only value a caller may
 * branch on: it is stable and machine-readable, while `message` is localized
 * Chinese prose meant for the panel.
 *
 * @module dsh-workspace-manager/host/errors
 */

/**
 * The stable error discriminants of `docs/PROTOCOL.md`.
 *
 * `unknownMethod` and `badRequest` are wire-level; `noGit`, `busy`,
 * `notFound`, `pathExists`, `registryUnavailable`, `registryFailed`,
 * `storageFailed`, and `unsupported` are domain-level.
 */
export const CODES = Object.freeze({
  /** The endpoint is not in the method table. */
  unknownMethod: 'workspace-manager/unknown-method',
  /** The payload failed validation. */
  badRequest: 'workspace-manager/bad-request',
  /** `git` was not resolvable in this Host's execution world. */
  noGit: 'workspace-manager/no-git',
  /** A git command exited non-zero; `details.stderr` carries the tail. */
  gitFailed: 'workspace-manager/git-failed',
  /** The job queue reached its pending limit. */
  busy: 'workspace-manager/busy',
  /** The addressed `Repo`/`WorkspaceItem`/`Job` does not exist. */
  notFound: 'workspace-manager/not-found',
  /** The target directory already exists and is not empty. */
  pathExists: 'workspace-manager/path-exists',
  /** `workspaceRegistry` is absent, so the DSH workspace list cannot be changed. */
  registryUnavailable: 'workspace-manager/registry-unavailable',
  /** `workspaceRegistry.create/delete` rejected. */
  registryFailed: 'workspace-manager/registry-failed',
  /** The JSON store could not be read or written. */
  storageFailed: 'workspace-manager/storage-failed',
  /**
   * The Host does not compose a capability the operation needs, and the
   * unexpected-failure fallback: every deliberate failure names a more exact
   * code, so anything reaching the fallback is a defect reported with the
   * closest stable discriminant instead of an invented one.
   */
  unsupported: 'workspace-manager/unsupported',
})

/**
 * One failure the route can serialize: a stable `code`, a localized
 * `message`, and optional JSON-serializable `details`.
 */
export class WorkspaceManagerError extends Error {
  /**
   * @param code - One of {@link CODES}.
   * @param messageText - Localized human text shown by the panel.
   * @param details - Extra JSON-serializable facts (for example `stderr`).
   */
  constructor(code, messageText, details = {}) {
    super(messageText)
    this.name = 'WorkspaceManagerError'
    /** @type {string} stable discriminant. */
    this.code = code
    /** @type {Record<string, unknown>} machine-readable extra facts. */
    this.details = details
  }
}

/**
 * Build one {@link WorkspaceManagerError}.
 * @param code - One of {@link CODES}.
 * @param messageText - Localized human text.
 * @param details - Extra JSON-serializable facts.
 * @returns {WorkspaceManagerError} the failure value to throw.
 */
export function fail(code, messageText, details = {}) {
  return new WorkspaceManagerError(code, messageText, details)
}

/**
 * @param value - any thrown value.
 * @returns {boolean} whether it is one of this plugin's failures.
 */
export function isWorkspaceManagerError(value) {
  return value instanceof WorkspaceManagerError
}

/**
 * @param error - any thrown value.
 * @returns {string} a printable message.
 */
export function message(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/**
 * Project a thrown value into the `error` member of the response envelope.
 * @param error - any thrown value.
 * @returns {{code: string, message: string, details: Record<string, unknown>}} the wire error.
 */
export function toWireError(error) {
  if (isWorkspaceManagerError(error)) {
    return { code: error.code, message: error.message, details: { ...error.details } }
  }
  return { code: CODES.unsupported, message: message(error), details: {} }
}
