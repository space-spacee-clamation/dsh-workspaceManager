/**
 * Install (or remove) dsh-workspace-manager in a DSH profile.
 *
 * What it does, and nothing else:
 *   1. junction `<profile>/node_modules/<pkg>` -> this package directory;
 *   2. add/refresh the `dependencies` entry in `<profile>/package.json`;
 *   3. append the plugin's bundle rows to `<profile>/cordis.patch.yml`, inside a
 *      clearly marked block.
 *
 * Step 3 is the hot mount: the launcher watches the profile patch file and
 * diffs the Loader tree, so no restart is needed — a browser refresh is enough.
 *
 * Every file it rewrites is backed up once to `<file>.bak-<timestamp>` before
 * the first change, and `--uninstall` reverses all three steps by marker, so
 * hand-written content around the managed block survives.
 *
 * Usage:
 *   node tools/install.mjs [--profile <dir>] [--uninstall] [--dry-run]
 *
 * The profile defaults to $DSH_PROFILE_DIR, then $DSH_HOME/profiles/desktop.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packageName = manifest.name
const patchFile = 'cordis.patch.yml'

const MARK_START = `# >>> dsh-workspace-manager: ${packageName}`
const MARK_END = `# <<< dsh-workspace-manager: ${packageName}`

/** The bundle rows this package inserts; kept literally in sync with cordis.patch.yml. */
const BUNDLE_ROWS = [
  '- insert:',
  '    - id: workspace-manager',
  `      name: ${packageName}`,
]

/**
 * @param argv - process argv.
 * @returns parsed flags.
 */
function parseArgs(argv) {
  const options = { profile: '', uninstall: false, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--profile') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--profile needs a directory')
      options.profile = value
      index += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * @returns the profile directory to operate on.
 * @throws when none can be resolved.
 */
function resolveProfile() {
  const explicit = parseArgs(process.argv.slice(2)).profile
  if (explicit !== '') return path.resolve(explicit)
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return path.resolve(fromEnv)
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', 'desktop')
}

/**
 * Copy a file aside once per run, before its first rewrite.
 * @param file - absolute path about to change.
 * @param stamp - shared timestamp suffix.
 * @param done - set of already-backed-up paths.
 */
function backup(file, stamp, done) {
  if (done.has(file) || !fs.existsSync(file)) return
  done.add(file)
  fs.copyFileSync(file, `${file}.bak-${stamp}`)
}

/**
 * Remove this package's managed block from a patch document.
 * @param text - current file contents.
 * @returns the text without the block.
 * @throws when a start marker has no matching end marker.
 */
function stripBlock(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === MARK_START)
  if (start === -1) return text
  const end = lines.findIndex((line, index) => index > start && line.trim() === MARK_END)
  if (end === -1) throw new Error(`managed block in ${patchFile} has a start marker but no end marker`)
  lines.splice(start, end - start + 1)
  const result = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  return result.trim() === '' ? '[]\n' : result
}

/**
 * True when the document already carries this package's managed block.
 * @param text - current file contents.
 */
function hasBlock(text) {
  return text.split(/\r?\n/).some(line => line.trim() === MARK_START)
}

/**
 * Extend the profile patch document with the managed block.
 * @param text - current file contents.
 * @returns the new document text.
 */
function withBlock(text) {
  const body = text.trim() === '[]' || text.trim() === '' ? '' : `${text.trimEnd()}\n`
  return `${body}${MARK_START}\n${BUNDLE_ROWS.join('\n')}\n${MARK_END}\n`
}

/**
 * Read JSON with a helpful failure.
 * @param file - absolute path.
 * @returns the parsed document.
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Point `<profile>/node_modules/<pkg>` at this package directory. A directory
 * junction needs no privilege on Windows and is what `link:` produces.
 * @param profile - profile directory.
 * @param dryRun - report without writing.
 */
function linkPackage(profile, dryRun) {
  const modules = path.join(profile, 'node_modules')
  const link = path.join(modules, packageName)
  if (fs.existsSync(link)) {
    const stat = fs.lstatSync(link)
    const current = stat.isSymbolicLink() ? path.resolve(modules, fs.readlinkSync(link)) : undefined
    if (current === root) return `already linked -> ${root}`
    if (dryRun) return `would replace ${link}`
    fs.rmSync(link, { recursive: true, force: true })
  }
  if (dryRun) return `would link ${link} -> ${root}`
  fs.mkdirSync(modules, { recursive: true })
  fs.symlinkSync(root, link, 'junction')
  return `linked ${link} -> ${root}`
}

/**
 * Unlink the profile's package directory entry.
 * @param profile - profile directory.
 * @param dryRun - report without writing.
 */
function unlinkPackage(profile, dryRun) {
  const link = path.join(profile, 'node_modules', packageName)
  if (!fs.existsSync(link)) return 'no package link to remove'
  if (dryRun) return `would remove ${link}`
  fs.rmSync(link, { recursive: true, force: true })
  return `removed ${link}`
}

/**
 * Add or drop the `dependencies` entry in the profile manifest.
 * @param profile - profile directory.
 * @param install - true to add, false to remove.
 * @param stamp - backup timestamp suffix.
 * @param done - backed-up path set.
 * @param dryRun - report without writing.
 */
function editManifest(profile, install, stamp, done, dryRun) {
  const file = path.join(profile, 'package.json')
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist; is this a DSH profile directory?`)
  const doc = readJson(file)
  const spec = `link:${root.replace(/\\/g, '/')}`
  const dependencies = doc.dependencies ?? {}
  if (install) {
    if (dependencies[packageName] === spec) return `package.json already declares ${packageName}`
    dependencies[packageName] = spec
  } else if (packageName in dependencies) {
    delete dependencies[packageName]
  } else return 'package.json does not declare this package'
  doc.dependencies = dependencies
  if (dryRun) return `would write ${file}`
  backup(file, stamp, done)
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  return `updated ${file}`
}

/**
 * Apply or revert the watched patch file.
 * @param profile - profile directory.
 * @param install - true to add, false to remove.
 * @param stamp - backup timestamp suffix.
 * @param done - backed-up path set.
 * @param dryRun - report without writing.
 */
function editPatch(profile, install, stamp, done, dryRun) {
  const file = path.join(profile, patchFile)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]\n'
  if (install) {
    if (hasBlock(text)) return `${patchFile} already carries the managed block`
    if (dryRun) return `would write ${file}`
    backup(file, stamp, done)
    fs.writeFileSync(file, withBlock(text))
    return `wrote managed block into ${file}`
  }
  if (!hasBlock(text)) return `${patchFile} has no managed block`
  if (dryRun) return `would rewrite ${file}`
  backup(file, stamp, done)
  fs.writeFileSync(file, stripBlock(text))
  return `removed managed block from ${file}`
}

const options = parseArgs(process.argv.slice(2))
const profile = resolveProfile()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const done = new Set()
const install = !options.uninstall

if (!fs.existsSync(profile)) throw new Error(`profile directory does not exist: ${profile}`)

console.log(`${install ? 'Installing' : 'Removing'} ${packageName}@${manifest.version}`)
console.log(`  package: ${root}`)
console.log(`  profile: ${profile}`)
console.log(`  mode:    ${options.dryRun ? 'dry run' : 'write'}`)
console.log('')

const results = install
  ? [
    linkPackage(profile, options.dryRun),
    editManifest(profile, true, stamp, done, options.dryRun),
    editPatch(profile, true, stamp, done, options.dryRun),
  ]
  : [
    editPatch(profile, false, stamp, done, options.dryRun),
    editManifest(profile, false, stamp, done, options.dryRun),
    unlinkPackage(profile, options.dryRun),
  ]

for (const line of results) console.log(`  - ${line}`)

console.log('')
if (!options.dryRun && done.size > 0) {
  console.log('Backups written:')
  for (const file of done) console.log(`  - ${file}.bak-${stamp}`)
  console.log('')
}
if (install) {
  console.log('The launcher hot-mounts the patch change; refresh the DSH browser tab.')
  console.log('If the panel does not appear, restart DSH once.')
} else {
  console.log('The launcher hot-unmounts the removed rows; refresh the DSH browser tab.')
}
