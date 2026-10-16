/**
 * Identifier minting for the Workspace Manager Host half.
 *
 * @module dsh-workspace-manager/host/ids
 */

import { randomUUID } from 'node:crypto'

/**
 * Mint one opaque identifier with a readable prefix, so a job id and a record
 * id can never be confused in a log line.
 * @param prefix - short lowercase namespace, for example `job`.
 * @returns {string} a unique id such as `job-3f2a…`.
 */
export function newId(prefix) {
  return `${prefix}-${randomUUID()}`
}

/**
 * @returns {string} the current instant as an ISO-8601 string.
 */
export function nowIso() {
  return new Date().toISOString()
}
