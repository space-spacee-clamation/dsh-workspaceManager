// Test infrastructure: a real `subprocess`-capability adapter for the Host
// half. It mirrors the `SubprocessRuntime` service definition of
// `@deepseek-ai/dsh-subprocess` (resolveExecutable / spawn / collected readers /
// terminate / waitForExit) but launches real `git` through `node:child_process`
// instead of the harness's managed process range. `node:child_process` is
// deliberate here: this file is test infrastructure, not plugin code.

import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WIN32 = process.platform === 'win32'

/** Environment applied to every spawned git so a spec is hermetic and cannot prompt. */
export const HERMETIC_GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
})

/** Raised when `resolveExecutable` cannot find the requested program. */
export class SubprocessExecutableNotFoundError extends Error {
  /** @param message - lookup diagnostic. */
  constructor(message) {
    super(message)
    this.name = 'SubprocessExecutableNotFoundError'
  }
}

/** @param candidate - path to test. @returns whether it is an executable file. */
function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false
  } catch {
    return false
  }
  if (WIN32) return true
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve one bare or absolute command against `env.PATH`, PATH-extensions
 * included on Windows.
 * @param command - absolute path or bare PATH name.
 * @param env - environment holding PATH/PATHEXT.
 * @returns the canonical executable path.
 * @throws {SubprocessExecutableNotFoundError} when nothing matches.
 */
export function resolveExecutablePath(command, env = process.env) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new SubprocessExecutableNotFoundError('resolveExecutable requires a non-empty command')
  }
  if (path.isAbsolute(command)) {
    if (isExecutableFile(command)) return command
    throw new SubprocessExecutableNotFoundError(`not an executable file: ${command}`)
  }
  if (command.includes('/') || command.includes('\\')) {
    throw new SubprocessExecutableNotFoundError(`relative path with a separator is not resolvable: ${command}`)
  }
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = WIN32 ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  throw new SubprocessExecutableNotFoundError(`cannot find "${command}" on PATH`)
}

/**
 * Offset-addressable byte buffer with a bounded in-memory tail, reproducing
 * `SubprocessOutputReader.readFrom` (whole-stream byte offsets, `lossy` when the
 * requested offset slid out of the tail).
 */
class CollectedStream {
  /** @param maxBytes - in-memory cap; overflow keeps the tail. */
  constructor(maxBytes) {
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 8 * 1024 * 1024
    this.buffer = Buffer.alloc(0)
    /** Whole-stream offset of `buffer[0]`. */
    this.headOffset = 0
  }

  /** @param chunk - bytes appended by the child. */
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    if (this.buffer.length > this.maxBytes) {
      const overflow = this.buffer.length - this.maxBytes
      this.buffer = this.buffer.subarray(overflow)
      this.headOffset += overflow
    }
  }

  /**
   * @param fromByte - whole-stream offset to resume from.
   * @returns the delta text, the next whole-stream offset, and the lossy flag.
   */
  readFrom(fromByte) {
    const start = Number.isFinite(fromByte) && fromByte > 0 ? Math.floor(fromByte) : 0
    if (start < this.headOffset) {
      return { text: this.buffer.toString('utf8'), nextOffset: this.headOffset + this.buffer.length, lossy: true }
    }
    const slice = this.buffer.subarray(Math.min(start - this.headOffset, this.buffer.length))
    return { text: slice.toString('utf8'), nextOffset: start + slice.length, lossy: false }
  }
}

/** @param mode - one per-stream stdio disposition. @returns the Node stdio word and its collect cap. */
function nodeStdio(mode, fallback) {
  const value = mode === undefined ? fallback : mode
  if (value === 'inherit' || value === 'ignore' || value === 'pipe') return { node: value, collect: null }
  if (value !== null && typeof value === 'object' && typeof value.maxBytes === 'number') {
    return { node: 'pipe', collect: value.maxBytes }
  }
  throw new TypeError(`unsupported stdio disposition: ${JSON.stringify(value)}`)
}

/**
 * Build one `SubprocessHandle`-shaped object over a Node child process.
 * @param child - the spawned child.
 * @param spec - the original spawn spec.
 * @param call - the recorded call, mutated with the settled outcome.
 * @returns the live handle.
 */
function createHandle(child, spec, call) {
  const stdoutMode = nodeStdio(spec.stdio?.stdout, { maxBytes: 1024 * 1024 })
  const stderrMode = nodeStdio(spec.stdio?.stderr, { maxBytes: 1024 * 1024 })
  const stdinMode = spec.stdio?.stdin ?? 'ignore'

  const collected = {}
  const stdoutCollect = stdoutMode.collect === null ? null : new CollectedStream(stdoutMode.collect)
  const stderrCollect = stderrMode.collect === null ? null : new CollectedStream(stderrMode.collect)
  if (stdoutCollect !== null) {
    collected.stdout = { readFrom: (offset) => stdoutCollect.readFrom(offset) }
    child.stdout.on('data', (chunk) => stdoutCollect.push(chunk))
  }
  if (stderrCollect !== null) {
    collected.stderr = { readFrom: (offset) => stderrCollect.readFrom(offset) }
    child.stderr.on('data', (chunk) => stderrCollect.push(chunk))
  }

  let settled = false
  let outcome = null
  let killTimer = null
  const done = new Promise((resolve, reject) => {
    const settle = (value, error) => {
      if (settled) return
      settled = true
      if (killTimer !== null) clearTimeout(killTimer)
      if (error !== undefined) reject(error)
      else {
        outcome = value
        call.endedAt = Date.now()
        call.exitCode = value.exitCode
        call.signal = value.signal
        resolve(value)
      }
    }
    child.once('error', (error) => settle(undefined, error))
    child.once('close', (exitCode, signal) => settle({ exitCode, signal }, undefined))
  })
  // A rejected `done` nobody awaits must not abort the test process.
  done.catch(() => {})

  if (stdinMode === 'pipe') {
    // exposed below
  } else if (stdinMode !== 'ignore' && stdinMode !== null && typeof stdinMode === 'object' && 'data' in stdinMode) {
    child.stdin.end(String(stdinMode.data))
  }

  const stdin = child.stdin
  const handle = {
    stdin: stdinMode === 'pipe' ? stdin : undefined,
    stdout: stdoutMode.node === 'pipe' && stdoutCollect === null ? child.stdout : undefined,
    stderr: stderrMode.node === 'pipe' && stderrCollect === null ? child.stderr : undefined,
    control: undefined,
    collected,
    done,
    /** Start the terminate escalation; idempotent. */
    terminate() {
      if (settled) return
      call.terminated = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, Number.isFinite(spec.graceMs) ? spec.graceMs : 500)
      killTimer.unref?.()
    },
    /**
     * @param signal - optional bound for the wait.
     * @returns true when the process exited, false when the signal aborted first.
     */
    async waitForExit(signal) {
      if (settled) return true
      if (signal === undefined) {
        await done.catch(() => {})
        return true
      }
      if (signal.aborted) return false
      return await new Promise((resolve) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(false) }
        signal.addEventListener('abort', onAbort, { once: true })
        done.then(
          () => { signal.removeEventListener('abort', onAbort); resolve(true) },
          () => { signal.removeEventListener('abort', onAbort); resolve(true) },
        )
      })
    },
  }
  return handle
}

/**
 * Create the `subprocess` capability the Host half consumes.
 * @param options - `env` merges over `process.env`; `onSpawn` observes each launch.
 * @returns an object exposing `resolveExecutable`, `spawn`, and the recorded `calls`.
 */
export function createGitSubprocess(options = {}) {
  const baseEnv = options.env ?? {}
  const calls = []
  return {
    calls,
    /**
     * @param command - executable to resolve.
     * @param env - explicit lookup environment.
     * @param signal - abort signal.
     * @returns the canonical executable path.
     */
    async resolveExecutable(command, env, signal) {
      if (signal?.aborted) throw new Error('resolveExecutable aborted')
      return resolveExecutablePath(command, { ...process.env, ...baseEnv, ...env })
    },
    /**
     * @param spec - argv/cwd/stdio/graceMs/signal, as the DSH seam defines them.
     * @returns the live handle.
     */
    spawn(spec) {
      const argv = Array.isArray(spec.argv) ? [...spec.argv] : []
      if (typeof spec.command === 'string') argv.unshift(spec.command)
      if (argv.length === 0) throw new TypeError('spawn requires argv')
      const file = argv.shift()
      const call = {
        file,
        args: [...argv],
        cwd: spec.cwd,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        signal: null,
        terminated: false,
      }
      calls.push(call)
      if (typeof options.onSpawn === 'function') options.onSpawn(call)
      const child = spawnProcess(file, argv, {
        cwd: spec.cwd,
        env: { ...process.env, ...HERMETIC_GIT_ENV, ...baseEnv, ...(spec.env ?? {}) },
        stdio: [
          spec.stdio?.stdin === 'pipe' || (spec.stdio?.stdin !== null && typeof spec.stdio?.stdin === 'object') ? 'pipe' : 'ignore',
          nodeStdio(spec.stdio?.stdout, { maxBytes: 1024 * 1024 }).node,
          nodeStdio(spec.stdio?.stderr, { maxBytes: 1024 * 1024 }).node,
        ],
        windowsHide: true,
      })
      const handle = createHandle(child, spec, call)
      if (spec.signal !== undefined && spec.signal !== null) {
        if (spec.signal.aborted) handle.terminate()
        else spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      }
      return handle
    },
  }
}

/**
 * Wrap a subprocess adapter so concurrent git jobs are observable.
 * @param adapter - the adapter to wrap.
 * @param options - `lingerMs` widens the observation window after exit.
 * @returns the wrapped adapter plus its `state` counters.
 */
export function trackConcurrency(adapter, options = {}) {
  const lingerMs = options.lingerMs ?? 0
  const state = { active: 0, maxActive: 0, spawns: 0 }
  return {
    state,
    resolveExecutable: (...args) => adapter.resolveExecutable(...args),
    calls: adapter.calls,
    spawn(spec) {
      state.spawns += 1
      state.active += 1
      if (state.active > state.maxActive) state.maxActive = state.active
      const handle = adapter.spawn(spec)
      const release = () => { state.active -= 1 }
      const done = handle.done.then(
        async (outcome) => {
          if (lingerMs > 0) await new Promise((resolve) => setTimeout(resolve, lingerMs))
          release()
          return outcome
        },
        (error) => {
          release()
          throw error
        },
      )
      done.catch(() => {})
      return { ...handle, done }
    },
  }
}
