#!/usr/bin/env node
/**
 * 按来源清单收录插件。
 *
 * 对清单中的每一项:取得源码、安装依赖、构建、把 dist 产物写入合集目录,
 * 再更新该插件的版本列表、该作者的插件清单与根目录插件目录。
 * 单项失败只跳过该项并记录原因,不影响其他项,退出码保持 0。
 *
 * 与旧版 JSON 签名实现的差别:不再处理 plugin_sign.json 与 plugin_secret.pub,
 * 改为复制作者侧分离签名(plugin.js.sig 与 meta.json.sig 分别落为
 * plugin.js.author.sig 与 meta.json.author.sig),以及作者公钥 dist/author_pub.pem
 * 到 plugins/<author>/author_pub.pem。合集 CMS 签名由 build-collection.mjs --sign 生成。
 *
 * 用法:
 *   node scripts/import-plugins.mjs
 *   node scripts/import-plugins.mjs --manifest .github/plugins-sources.json
 *   node scripts/import-plugins.mjs --manifest ./sources.json --keep-temp
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const TEMP_DIR = join(ROOT_DIR, 'temp', 'import')
const DEFAULT_MANIFEST = '.github/plugins-sources.json'

const BUILD_TIMEOUT_MS = Number(process.env.IMPORT_BUILD_TIMEOUT_MS || 900000)
const IS_WINDOWS = process.platform === 'win32'
const COPY_SKIP = new Set(['node_modules', '.git', 'dist', 'temp'])

const AUTHOR_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const PLUGIN_PATTERN = /^(?:dsc-[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/dsc-[a-z0-9][a-z0-9._-]*)$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const URL_PATTERN = /^https?:\/\/\S+$/i
const GIT_PATTERN = /^(?:https:\/\/|git@|git:\/\/|ssh:\/\/)/i

/** dist 内可选的作者分离签名,键为源文件名,值为落盘到版本目录的文件名 */
const AUTHOR_SIGNATURE_MAP = [
  { source: 'plugin.js.sig', target: 'plugin.js.author.sig' },
  { source: 'meta.json.sig', target: 'meta.json.author.sig' },
]
/** dist 内的作者公钥文件名 */
const AUTHOR_PUB_SOURCE = 'author_pub.pem'
/** 作者目录内的作者公钥文件名 */
const AUTHOR_PUB_TARGET = 'author_pub.pem'

function usage() {
  process.stdout.write([
    '用法: node scripts/import-plugins.mjs [选项]',
    '',
    '选项:',
    '  --manifest <路径>   来源清单,默认 ' + DEFAULT_MANIFEST,
    '  --keep-temp         保留 temp/import 下的临时目录,便于排查',
    '  --help              显示本说明',
    '',
    '环境变量:',
    '  IMPORT_BUILD_TIMEOUT_MS   单项构建超时毫秒数,默认 900000',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST, keepTemp: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const separator = arg.indexOf('=')
    const flag = separator === -1 ? arg : arg.slice(0, separator)
    const inline = separator === -1 ? null : arg.slice(separator + 1)
    const take = () => {
      if (inline !== null) return inline
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(flag + ' 缺少取值')
      return value
    }
    switch (flag) {
      case '--manifest': options.manifest = take(); break
      case '--keep-temp': options.keepTemp = true; break
      case '--help':
      case '-h': options.help = true; break
      default: throw new Error('未知参数 ' + arg)
    }
  }
  return options
}

function log(message) {
  process.stdout.write(message + '\n')
}

function logWarning(message) {
  process.stderr.write('[警告] ' + message + '\n')
}

function logError(message) {
  process.stderr.write('[错误] ' + message + '\n')
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error('无法读取' + label + ' ' + path + ': ' + error.message)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(label + ' ' + path + ' 不是合法 JSON: ' + error.message)
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function quoteArg(value) {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const options = {
      cwd,
      env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    // Windows 上 pnpm 与 git 需要经 shell 调用,整条命令自行拼接并转义。
    const child = IS_WINDOWS
      ? spawn([command, ...args].map(quoteArg).join(' '), { ...options, shell: true })
      : spawn(command, args, options)

    let output = ''
    const collect = (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > 20000) output = output.slice(-20000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, BUILD_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(output)
        return
      }
      rejectPromise(new Error(command + ' ' + args.join(' ') + ' 退出码 ' + code + '\n' + output.trim()))
    })
  })
}

function resolveSource(repo) {
  const raw = repo.trim()
  const localPath = isAbsolute(raw) ? raw : resolve(ROOT_DIR, raw)
  if (existsSync(localPath) && statSync(localPath).isDirectory()) return { kind: 'local', path: localPath }
  if (GIT_PATTERN.test(raw)) return { kind: 'git', url: raw }
  throw new Error('repo 既不是已存在的本地目录,也不是 git 地址: ' + raw)
}

async function prepareSource(item, workDir) {
  rmSync(workDir, { recursive: true, force: true })
  const source = resolveSource(item.repo)
  if (source.kind === 'local') {
    cpSync(source.path, workDir, {
      recursive: true,
      filter: (src) => !COPY_SKIP.has(basename(src)),
    })
    return '已复制本地目录 ' + source.path
  }
  const args = ['clone', '--depth', '1', '--quiet']
  if (item.ref) args.push('--branch', String(item.ref))
  args.push(source.url, workDir)
  await run('git', args, ROOT_DIR)
  return '已克隆 ' + source.url + (item.ref ? ' 的 ' + item.ref : '')
}

async function buildSource(workDir) {
  await run('pnpm', ['install', '--frozen-lockfile'], workDir)
  await run('pnpm', ['build'], workDir)
}

function readDist(distDir) {
  const metaPath = join(distDir, 'meta.json')
  if (!existsSync(metaPath)) throw new Error('构建产物缺少 dist/meta.json')
  const meta = readJson(metaPath, 'dist/meta.json')
  if (!isObject(meta)) throw new Error('dist/meta.json 的顶层必须是对象')
  if (typeof meta.name !== 'string' || !PLUGIN_PATTERN.test(meta.name)) {
    throw new Error('dist/meta.json 的 name 不是合法插件名: ' + JSON.stringify(meta.name))
  }
  if (typeof meta.version !== 'string' || !VERSION_PATTERN.test(meta.version)) {
    throw new Error('dist/meta.json 的 version 不是 x.y.z: ' + JSON.stringify(meta.version))
  }
  const jsPath = join(distDir, 'plugin.js')
  if (!existsSync(jsPath)) throw new Error('构建产物缺少 dist/plugin.js')
  return { meta, metaPath, jsPath, distDir }
}

function planVersions(pluginDir, version) {
  const path = join(pluginDir, 'versions.json')
  const current = existsSync(path) ? readJson(path, 'versions.json') : { latest: version, versions: [] }
  if (!isObject(current)) throw new Error('versions.json 的顶层必须是对象: ' + path)
  const list = Array.isArray(current.versions) ? current.versions.filter((item) => typeof item === 'string') : []
  if (!list.includes(version)) list.push(version)
  list.sort(compareVersions).reverse()
  return { path, value: { latest: list[0], versions: list } }
}

function planPluginManifest(author, plugin) {
  const path = join(ROOT_DIR, 'plugins', author, 'plugin_manifest.json')
  const current = existsSync(path) ? readJson(path, 'plugin_manifest.json') : []
  if (!Array.isArray(current)) throw new Error('plugins/' + author + '/plugin_manifest.json 的顶层必须是插件名数组')
  const names = current.filter((item) => typeof item === 'string')
  if (!names.includes(plugin)) names.push(plugin)
  names.sort()
  return { path, value: names }
}

function planDatalog(plugin, author) {
  const path = join(ROOT_DIR, 'datalog.json')
  const current = existsSync(path) ? readJson(path, 'datalog.json') : []
  if (!Array.isArray(current)) throw new Error('datalog.json 的顶层必须是数组')
  const next = []
  let replaced = false
  for (const entry of current) {
    if (!isObject(entry) || entry.plugin_name !== plugin) {
      next.push(entry)
      continue
    }
    replaced = true
    next.push({
      plugin_name: plugin,
      author,
      tag: Array.isArray(entry.tag) ? entry.tag.filter((tag) => typeof tag === 'string') : [],
    })
  }
  if (!replaced) next.push({ plugin_name: plugin, author, tag: [] })
  return { path, value: next }
}

function planAuthorManifest(author, profile) {
  const path = join(ROOT_DIR, 'plugins', 'author_manifest.json')
  const current = existsSync(path) ? readJson(path, 'author_manifest.json') : []
  if (!Array.isArray(current)) throw new Error('plugins/author_manifest.json 的顶层必须是数组')
  const next = []
  let replaced = false
  for (const entry of current) {
    if (isObject(entry) && entry.username === author) {
      replaced = true
      next.push({ username: author, profile })
      continue
    }
    next.push(entry)
  }
  if (!replaced) next.push({ username: author, profile })
  next.sort((left, right) => {
    const a = isObject(left) && typeof left.username === 'string' ? left.username : ''
    const b = isObject(right) && typeof right.username === 'string' ? right.username : ''
    return a < b ? -1 : a > b ? 1 : 0
  })
  return { path, value: next }
}

/**
 * 先写文件、失败时回滚。JSON 之间的引用关系一旦半途失败就会让合集不自洽,因此统一收口。
 */
function applyWrites(staged) {
  const applied = []
  try {
    for (const item of staged) {
      const previous = existsSync(item.path) ? readFileSync(item.path, 'utf8') : null
      writeJson(item.path, item.value)
      applied.push({ path: item.path, previous })
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.previous === null) rmSync(item.path, { force: true })
      else writeFileSync(item.path, item.previous, 'utf8')
    }
    throw error
  }
}

function validateItem(item, label) {
  if (!isObject(item)) throw new Error(label + ' 必须是对象')
  const author = typeof item.author === 'string' ? item.author.trim() : ''
  const plugin = typeof item.plugin === 'string' ? item.plugin.trim() : ''
  if (!AUTHOR_PATTERN.test(author)) throw new Error(label + ' 的 author 不是合法作者名: ' + JSON.stringify(item.author))
  if (!PLUGIN_PATTERN.test(plugin)) throw new Error(label + ' 的 plugin 不是合法插件名: ' + JSON.stringify(item.plugin))
  if (typeof item.repo !== 'string' || item.repo.trim() === '') throw new Error(label + ' 缺少 repo')
  if (item.ref !== undefined && (typeof item.ref !== 'string' || item.ref.trim() === '')) {
    throw new Error(label + ' 的 ref 必须是非空字符串')
  }
  if (item.profile !== undefined && (typeof item.profile !== 'string' || !URL_PATTERN.test(item.profile.trim()))) {
    throw new Error(label + ' 的 profile 必须是 http 或 https 地址')
  }
  return { author, plugin, profile: typeof item.profile === 'string' ? item.profile.trim() : null }
}

async function importOne(item, label, options) {
  const { author, plugin, profile } = validateItem(item, label)
  const dirName = plugin.split('/').pop()
  const authorDir = join(ROOT_DIR, 'plugins', author)
  const pluginDir = join(authorDir, dirName)
  const workDir = join(TEMP_DIR, author + '-' + dirName)
  let versionDir = null

  try {
    log('  ' + (await prepareSource(item, workDir)))
    await buildSource(workDir)

    const { meta, metaPath, jsPath, distDir } = readDist(join(workDir, 'dist'))
    if (meta.name !== plugin) {
      throw new Error('dist/meta.json 的 name 为 ' + meta.name + ',与清单的 ' + plugin + ' 不一致')
    }
    const version = meta.version
    versionDir = join(pluginDir, version)
    mkdirSync(versionDir, { recursive: true })
    cpSync(metaPath, join(versionDir, 'meta.json'))
    cpSync(jsPath, join(versionDir, 'plugin.js'))

    // 作者分离签名:插件仓库构建出的 <文件>.sig 落为 <文件>.author.sig
    const copiedSignatures = []
    for (const mapping of AUTHOR_SIGNATURE_MAP) {
      const source = join(distDir, mapping.source)
      if (!existsSync(source)) continue
      cpSync(source, join(versionDir, mapping.target))
      copiedSignatures.push(mapping.target)
    }

    // 作者公钥:随合集分发,供验签方校验作者签名
    const pubSource = join(distDir, AUTHOR_PUB_SOURCE)
    let pubCopied = false
    if (existsSync(pubSource)) {
      mkdirSync(authorDir, { recursive: true })
      cpSync(pubSource, join(authorDir, AUTHOR_PUB_TARGET))
      pubCopied = true
    }

    if (copiedSignatures.length > 0 && !pubCopied && !existsSync(join(authorDir, AUTHOR_PUB_TARGET))) {
      logWarning('plugins/' + author + '/' + AUTHOR_PUB_TARGET + ' 不存在,作者签名将无法校验')
    }
    if (copiedSignatures.length === 0) {
      log('  插件未带作者签名,该版本只有合集 CMS 签名')
    }

    const staged = [planVersions(pluginDir, version), planPluginManifest(author, plugin), planDatalog(plugin, author)]
    // 未给出 profile 时不写作者清单,避免登记一条没有主页的条目;校验脚本会就此给出警告。
    if (profile) staged.push(planAuthorManifest(author, profile))

    applyWrites(staged)
    return { version, copiedSignatures, pubCopied }
  } catch (error) {
    if (versionDir) rmSync(versionDir, { recursive: true, force: true })
    throw error
  } finally {
    if (!options.keepTemp) rmSync(workDir, { recursive: true, force: true })
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    logError('收录失败: ' + error.message)
    usage()
    return 2
  }
  if (options.help) {
    usage()
    return 0
  }

  const manifestPath = isAbsolute(options.manifest) ? options.manifest : resolve(ROOT_DIR, options.manifest)
  if (!existsSync(manifestPath)) {
    logError('收录失败: 来源清单不存在: ' + manifestPath)
    return 2
  }
  let sources
  try {
    sources = readJson(manifestPath, '来源清单')
  } catch (error) {
    logError('收录失败: ' + error.message)
    return 2
  }
  if (!Array.isArray(sources)) {
    logError('收录失败: 来源清单的顶层必须是数组')
    return 2
  }
  if (sources.length === 0) {
    log('来源清单为空,没有需要收录的插件')
    return 0
  }

  mkdirSync(TEMP_DIR, { recursive: true })
  let imported = 0
  let skipped = 0

  for (const [index, item] of sources.entries()) {
    const label = '第 ' + (index + 1) + ' 项'
    const name = isObject(item) && typeof item.plugin === 'string' ? item.plugin : '(缺少 plugin 字段)'
    log('[' + label + '] ' + name)
    try {
      const result = await importOne(item, label, options)
      const signatureNote = result.copiedSignatures.length > 0 ? ',作者签名 ' + result.copiedSignatures.join('、') : ''
      const pubNote = result.pubCopied ? ',已更新作者公钥' : ''
      log('  已收录 ' + name + '@' + result.version + signatureNote + pubNote)
      imported += 1
    } catch (error) {
      logError('  跳过 ' + name + ': ' + (error && error.message ? error.message : String(error)))
      skipped += 1
    }
  }

  rmSync(TEMP_DIR, { recursive: true, force: true })
  log('收录汇总: 成功 ' + imported + ' 个,跳过 ' + skipped + ' 个')
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  logError('收录失败: ' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
}
