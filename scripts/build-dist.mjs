#!/usr/bin/env node
/**
 * Build the shareable packages for this plugin.
 *
 * The one thing that must never drift: the package name in `package.json`, the
 * plugin row name in `cordis.patch.yml`, and the client module id in
 * `client/client.js` all have to be IDENTICAL. The staged copy is rewritten
 * from `package.json` before anything is packed, and BOTH artifacts are
 * extracted and re-verified before they are written to the output directory —
 * a build that fails leaves no package behind.
 *
 * Usage (run from the package root):
 *   node scripts/build-dist.mjs                 # writes dist/ next to package.json
 *   node scripts/build-dist.mjs --out <dir>     # writes into <dir>
 *
 * No dependencies: tgz uses the system tar, the zip writer and reader are both
 * in this file (stored entries only).
 */
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const NAME = MANIFEST.name
const VERSION = MANIFEST.version

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

/** Expand the `files` list into concrete package-relative paths. */
async function collectFiles() {
  const files = []
  // npm always ships package.json, whether or not it is listed in "files".
  files.push('package.json')
  for (const entry of MANIFEST.files ?? []) {
    if (entry.includes('*')) {
      const star = entry.indexOf('*')
      const slash = entry.lastIndexOf('/', star)
      const dirPart = slash === -1 ? '' : entry.slice(0, slash)
      const pattern = entry.slice(slash + 1)
      const matcher = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')}$`, 'u')
      const directory = join(ROOT, dirPart)
      for (const child of await readdir(directory)) {
        if (!matcher.test(child)) continue
        files.push(dirPart.length > 0 ? `${dirPart}/${child}` : child)
      }
      continue
    }
    const absolute = join(ROOT, entry)
    let info
    try {
      info = await stat(absolute)
    } catch {
      throw new Error(`package.json "files" entry does not exist: ${entry}`)
    }
    if (info.isDirectory()) {
      for (const child of await collectDirectory(absolute, ROOT)) files.push(child)
      continue
    }
    files.push(entry)
  }
  return [...new Set(files.map((file) => file.split(sep).join('/')))].sort()
}

async function collectDirectory(directory, base) {
  const out = []
  for (const child of await readdir(directory)) {
    const absolute = join(directory, child)
    const info = await stat(absolute)
    if (info.isDirectory()) out.push(...(await collectDirectory(absolute, base)))
    else out.push(relative(base, absolute))
  }
  return out
}

async function walkFiles(directory, base = directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(absolute, base)))
    else out.push(relative(base, absolute))
  }
  return out
}

/** Rewrite the plugin row name in a staged patch to this package's name. */
async function rewritePatch(stagedPatch) {
  const text = await readFile(stagedPatch, 'utf8')
  let replaced = false
  const rewritten = text.replace(/^(\s*name:\s*).*$/mu, (_line, prefix) => {
    replaced = true
    return `${prefix}'${NAME}'`
  })
  if (!replaced) throw new Error('cordis.patch.yml has no "name:" line to rewrite')
  await writeFile(stagedPatch, rewritten, 'utf8')
  const check = await readFile(stagedPatch, 'utf8')
  const names = [...check.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gmu)].map((match) => match[1])
  if (names.length !== 1 || names[0] !== NAME) {
    throw new Error(`staged patch name ${JSON.stringify(names)} does not match package name ${NAME}`)
  }
  return { original: text, staged: check }
}

/** Rewrite the client module id so it names this package, not the linked dev tree. */
async function rewriteClientId(stagedClient) {
  const text = await readFile(stagedClient, 'utf8')
  const pattern = /(__ModuleLoader__\.load\(\s*\{\s*id:\s*)'[^']*'/u
  if (!pattern.test(text)) throw new Error('client.js has no __ModuleLoader__.load id to rewrite')
  const rewritten = text.replace(pattern, `$1'${NAME}'`)
  await writeFile(stagedClient, rewritten, 'utf8')
  const check = await readFile(stagedClient, 'utf8')
  if (!check.includes(`id: '${NAME}'`)) throw new Error(`client module id was not rewritten to ${NAME}`)
  if (check.includes('@local/')) throw new Error('staged client.js still references @local')
}

function buildTgz(stageDir, target) {
  const result = spawnSync('tar', ['-czf', target, '-C', stageDir, 'package'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`)
}

function extractTgz(tgz, targetDir) {
  const result = spawnSync('tar', ['-xzf', tgz, '-C', targetDir], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`tar extraction failed with status ${result.status}`)
}

/** Write stored-entry zip; the same layout is parsed back by extractZip(). */
async function buildZip(stageDir, target, rootName) {
  const packageDir = join(stageDir, 'package')
  const entries = []
  for (const file of await collectDirectory(packageDir, packageDir)) {
    const data = await readFile(join(packageDir, file))
    const name = Buffer.from(`${rootName}/${file.split(sep).join('/')}`, 'utf8')
    const { time, day } = dosDateTime(new Date())
    entries.push({ name, data, crc: crc32(data), time, day })
  }
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 filename
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(entry.time, 10)
    local.writeUInt16LE(entry.day, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(entry.name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, entry.name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(entry.time, 12)
    central.writeUInt16LE(entry.day, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(entry.name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, entry.name)
    offset += local.length + entry.name.length + entry.data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  await writeFile(target, Buffer.concat([...locals, centralBuffer, end]))
}

/** Extract a stored-entry zip produced by buildZip(). */
async function extractZip(zipPath, targetDir) {
  const buffer = await readFile(zipPath)
  let offset = 0
  let count = 0
  while (offset + 4 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset)
    if (signature === 0x02014b50) break // central directory starts
    if (signature !== 0x04034b50) throw new Error(`zip entry ${count} has bad local header`)
    if (offset + 30 > buffer.length) throw new Error('zip header truncated')
    const method = buffer.readUInt16LE(offset + 8)
    const crc = buffer.readUInt32LE(offset + 14)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const size = buffer.readUInt32LE(offset + 22)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength)
    const dataStart = offset + 30 + nameLength + extraLength
    const data = buffer.subarray(dataStart, dataStart + size)
    if (method !== 0 || compressedSize !== size) throw new Error(`zip entry ${name} is not stored`)
    if (crc32(data) !== crc) throw new Error(`zip entry ${name} has a CRC mismatch`)
    const parts = name.split('/').filter((part) => part.length > 0)
    if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) throw new Error(`zip entry ${name} has an unsafe path`)
    const target = join(targetDir, ...parts)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
    offset = dataStart + size
    count += 1
  }
  if (count === 0) throw new Error('zip has no entries')
  return count
}

/**
 * Shared verifier for both artifacts: extract first, then call this on the
 * extraction directory with the expected top-level directory name.
 */
async function verifyExtracted(extractDir, expectRoot) {
  const rootDir = join(extractDir, expectRoot)
  let info
  try {
    info = await stat(rootDir)
  } catch {
    throw new Error(`artifact has no ${expectRoot}/ root`)
  }
  if (!info.isDirectory()) throw new Error(`${expectRoot} is not a directory`)

  const manifest = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'))
  if (manifest.name !== NAME) throw new Error(`package.json name ${manifest.name} != ${NAME}`)

  const patchRelative = manifest.dsh?.bundle?.patch
  if (typeof patchRelative !== 'string' || patchRelative.length === 0) {
    throw new Error('package.json has no dsh.bundle.patch')
  }
  const patchPath = join(rootDir, patchRelative)
  try {
    await stat(patchPath)
  } catch {
    throw new Error(`dsh.bundle.patch points at a missing file: ${patchRelative}`)
  }
  const patch = await readFile(patchPath, 'utf8')
  const row = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(patch)
  if (row === null || row[1] !== NAME) throw new Error(`patch name ${row?.[1]} != ${NAME}`)

  const client = await readFile(join(rootDir, 'client', 'client.js'), 'utf8')
  if (!client.includes(`id: '${NAME}'`)) throw new Error(`client module id != ${NAME}`)

  for (const file of await walkFiles(rootDir)) {
    const segments = file.split(sep)
    if (segments.some((segment) => segment === '.git' || segment === 'node_modules' || segment === 'scripts')) {
      throw new Error(`artifact contains a forbidden path: ${file}`)
    }
    if (/\.(?:tgz|zip)$/iu.test(file)) throw new Error(`artifact contains a nested archive: ${file}`)
    const text = await readFile(join(rootDir, file), 'utf8')
    if (text.includes('@local/')) throw new Error(`artifact still references @local/: ${file}`)
  }
  return { files: (await walkFiles(rootDir)).length }
}

async function main() {
  const files = await collectFiles()
  const baseName = `${NAME}-${VERSION}`
  const outDir = (() => {
    const index = process.argv.indexOf('--out')
    return index === -1 ? join(ROOT, 'dist') : resolve(process.argv[index + 1])
  })()
  const tgzFinal = join(outDir, `${baseName}.tgz`)
  const zipFinal = join(outDir, `${baseName}.zip`)
  await mkdir(outDir, { recursive: true })
  // A failed build must not leave a package behind.
  await rm(tgzFinal, { force: true })
  await rm(zipFinal, { force: true })

  const stage = join(tmpdir(), `dsh-market-notes-dist-${Date.now()}`)
  const packageDir = join(stage, 'package')
  try {
    for (const file of files) {
      const target = join(packageDir, file)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(ROOT, file), target)
    }
    const { original, staged } = await rewritePatch(join(packageDir, 'cordis.patch.yml'))
    await rewriteClientId(join(packageDir, 'client', 'client.js'))
    const sourceName = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(original)?.[1]
    if (sourceName !== NAME) console.log(`note: source patch says ${sourceName}; staged copy rewritten to ${NAME}`)

    const tgzStage = join(stage, `${baseName}.tgz`)
    buildTgz(stage, tgzStage)
    const tgzExtract = join(stage, 'verify-tgz')
    await mkdir(tgzExtract, { recursive: true })
    extractTgz(tgzStage, tgzExtract)
    const tgzInfo = await verifyExtracted(tgzExtract, 'package')

    const zipStage = join(stage, `${baseName}.zip`)
    await buildZip(stage, zipStage, baseName)
    const zipExtract = join(stage, 'verify-zip')
    await extractZip(zipStage, zipExtract)
    const zipInfo = await verifyExtracted(zipExtract, baseName)

    await copyFile(tgzStage, tgzFinal)
    await copyFile(zipStage, zipFinal)
    console.log(`verified: tgz ${baseName}.tgz (${(await stat(tgzFinal)).size} bytes, ${tgzInfo.files} files)`)
    console.log(`verified: zip ${baseName}.zip (${(await stat(zipFinal)).size} bytes, ${zipInfo.files} files)`)
    console.log(`checks: package name = patch name = client id = ${NAME}; no @local/; no dev-only paths`)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`build-dist failed: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}

export { extractZip, verifyExtracted }
