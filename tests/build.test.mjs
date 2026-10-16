// Build-output contract: `tools/build.mjs --check` must consider `lib/`
// current, the emitted browser half must be exactly one
// `window.__ModuleLoader__.load({ id, factory })` registration whose id is the
// package name, and the host entry must exist at the package `main`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** @param source - file contents. @returns the first line that is neither blank nor a comment. */
function firstCodeLine(source) {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//')) continue
    return trimmed
  }
  return ''
}

test('tools/build.mjs --check reports current build output', () => {
  const result = spawnSync(process.execPath, ['tools/build.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(
    result.status,
    0,
    `node tools/build.mjs --check exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
})

test('lib/client.js is one module-loader registration', () => {
  const source = read('lib/client.js')
  assert.equal(
    firstCodeLine(source).startsWith('window.__ModuleLoader__.load('),
    true,
    `the first code line of lib/client.js must be the registration, received: ${JSON.stringify(firstCodeLine(source))}`,
  )
  const statements = source.split(/\r?\n/).filter((line) => /^\s*window\.__ModuleLoader__\.load\(/.test(line))
  assert.equal(statements.length, 1, 'lib/client.js must register exactly one bundle factory')
  assert.equal(
    /^\s*(import|export)\s/m.test(source),
    false,
    'the emitted bundle must carry no top-level ESM syntax',
  )
})

test('lib/client.js registers under the package name', () => {
  const source = read('lib/client.js')
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")/.exec(source)
  assert.ok(match !== null, 'lib/client.js must register with a literal string id')
  assert.equal(JSON.parse(match[1]), packageJson.name)
})

test('the host entry ships at the package main', () => {
  assert.equal(packageJson.main, 'lib/index.js')
  const entry = path.join(ROOT, 'lib/index.js')
  assert.equal(fs.existsSync(entry), true, 'lib/index.js is missing; run `node tools/build.mjs`')
  assert.ok(fs.statSync(entry).size > 0, 'lib/index.js is empty')
})

test('every relative import in the shipped host half resolves', () => {
  const lib = path.join(ROOT, 'lib')
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.js') && full !== path.join(lib, 'client.js') ? [full] : []
  })
  for (const file of walk(lib)) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1])
      assert.equal(fs.existsSync(target), true, `${path.relative(ROOT, file)} imports "${match[1]}", which is missing from lib/`)
    }
  }
})
