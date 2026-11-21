#!/usr/bin/env node
/**
 * 校验合集并生成分发内容。
 *
 * 流程:--sign 时先用 EEC 为每个版本的 plugin.js 生成 CMS 分离签名,
 * 再生成三层哈希清单(L1 合集根、L2 作者目录、L3 插件目录)并逐层签名,
 * 然后校验合集,校验不通过则以非零退出码结束并列出全部问题;
 * 校验通过后把根目录元数据、三层清单、certs/ 目录与 plugins/ 目录复制到输出目录,
 * 并写入 build-info.json 作为分发索引。根证书不进 dist,由 DeepSeek-Chat-Enhanced 的 certs 分支分发。
 *
 * revision 语义:该层文件集合与哈希都没变时沿用旧 revision,有变化时加一,
 * 没有旧清单时从 1 开始。旧清单从该层目录现有的 manifest.json 读取。
 *
 * 用法:
 *   node scripts/build-collection.mjs --dir . --root-ca root_ca.crt --out dist
 *   EEC_SECRET_KEY=... node scripts/build-collection.mjs --dir . --root-ca root_ca.crt --sign --out dist
 *   node scripts/build-collection.mjs --dir template --allow-placeholder-eec --out dist
 *
 * 骨架里 certs/<合集 id>/_REPLACE_THIS_FILE_AS_YOUR_EEC_ 是占位文件,不是证书:
 * 带 --sign 时直接拒绝签名并提示替换;不带 --sign 时按 --allow-placeholder-eec 决定报错还是警告。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  LAYER1_FILES,
  LAYER1_OPTIONAL_FILES,
  LAYER2_FILES,
  LAYER3_FILES,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  PLUGINS_INDEX_FILE,
  formatProblems,
  resolveRootCaPath,
  verifyCollection,
} from './lib/collection-verify.mjs'
import {
  EEC_CERT_DIR,
  EEC_CERT_FILE,
  VERSION_SIGNED_FILES,
  certMatchesKey,
  describeCertificate,
  placeholderEecNotice,
  requireOpenssl,
  resolveEecCertPath,
  resolveKeyFile,
  signFileCms,
  signManifest,
} from './pki.mjs'

/**
 * 分发内容里的合集根文件。三层清单与签名一并分发,签名针对拷贝后的字节依然有效。
 * 终端签名证书不在这张表里:certs/ 整个目录由 writeDist 原样复制,证书改名或轮换都不用改这里。
 */
const ROOT_DIST_FILES = ['meta.json', PLUGINS_INDEX_FILE, 'tags.json', MANIFEST_FILE, MANIFEST_FILE + '.sig']

function usage() {
  process.stdout.write([
    '用法: node scripts/build-collection.mjs [选项]',
    '',
    '选项:',
    '  --dir <目录>                合集根目录,默认当前目录',
    '  --out <目录>                分发内容输出目录,默认 dist',
    '  --root-ca <路径>            根证书路径,用于校验证书链与 CMS 签名',
    '  --sign                      用 EEC_SECRET_KEY 为三层清单与每个版本的 plugin.js 生成 CMS 分离签名',
    '  --allow-placeholder-eec     骨架模式:终端签名证书仍是占位文件、根证书缺失或证书未由根 CA 签发时只警告',
    '  --collection-name <名称>    合集名称,默认取合集目录名;同时决定证书所在文件夹与文件名 certs/<合集 id>/<合集 id>-eec.crt',
    '  --help                      显示本说明',
    '',
    '环境变量:',
    '  ROOT_CA_PATH                根证书路径,等价于 --root-ca',
    '  EEC_SECRET_KEY              EEC 私钥,可为 PEM 文本或文件路径',
    '',
    '终端签名证书按 certs/<合集 id>/<合集 id>-eec.crt、certs/<合集 id>/_REPLACE_THIS_FILE_AS_YOUR_EEC_、',
    '根目录 eec.pem 的顺序读取;占位文件不是证书,--sign 会拒绝签名并提示替换。',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = {
    dir: '.',
    out: 'dist',
    rootCa: null,
    sign: false,
    allowPlaceholderEec: false,
    collectionName: null,
    help: false,
  }
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
      case '--dir': options.dir = take(); break
      case '--out': options.out = take(); break
      case '--root-ca': options.rootCa = take(); break
      case '--sign': options.sign = true; break
      case '--allow-placeholder-eec': options.allowPlaceholderEec = true; break
      case '--collection-name': options.collectionName = take(); break
      case '--help':
      case '-h': options.help = true; break
      default: throw new Error('未知参数 ' + arg)
    }
  }
  return options
}

function problem(level, code, message, path) {
  return { level, code, message, path: path ?? null }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 读取合集根的插件目录索引 plugins.json,缺失或结构不对时返回空数组。
 * 索引不可用时按空合集处理:具体是缺文件还是结构错,由校验脚本逐条报出,这里不重复。
 */
function readPluginsIndex(root) {
  const indexPath = join(root, PLUGINS_INDEX_FILE)
  if (!existsSync(indexPath)) return []
  try {
    const data = readJson(indexPath)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** 列出插件目录索引登记过的插件下的全部版本目录,供逐版本签名使用。 */
function listVersionDirs(root) {
  const found = []
  for (const entry of readPluginsIndex(root)) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.plugin_name !== 'string' || typeof entry.author !== 'string') continue
    const dirName = entry.plugin_name.split('/').pop()
    const pluginDir = join(root, 'plugins', entry.author, dirName)
    const versionsPath = join(pluginDir, 'versions.json')
    if (!existsSync(versionsPath)) continue
    let versions
    try {
      versions = readJson(versionsPath)
    } catch {
      continue
    }
    const list = Array.isArray(versions?.versions) ? versions.versions : []
    for (const version of list) {
      if (typeof version !== 'string') continue
      const versionDir = join(pluginDir, version)
      if (statSync(versionDir, { throwIfNoEntry: false })?.isDirectory()) found.push({ versionDir, version })
    }
  }
  return found
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 列出目录下的子目录名,按字典序排序;目录不存在时返回空数组。 */
function listDirectoryNames(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** 读取 versions.json 的版本列表,读不到时返回空数组。 */
function readVersionList(path) {
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const list = Array.isArray(data?.versions) ? data.versions : []
    return list.filter((item) => typeof item === 'string')
  } catch {
    return []
  }
}

/**
 * 解析 EEC 私钥并确认与合集内的终端签名证书配对。不配对时直接失败,避免产出一批无法验签的签名。
 * 证书位置按 certs/<合集 id>/<合集 id>-eec.crt、占位文件、旧布局 eec.pem 的顺序解析;
 * 解析到占位文件时拒绝签名:占位文件不是证书,提示先替换成真实证书。
 */
function prepareSigner(root, problems, options = {}) {
  const source = process.env.EEC_SECRET_KEY
  if (!source) {
    problems.push(problem('error', 'SIGN_KEY_MISSING', '启用 --sign 时需要环境变量 EEC_SECRET_KEY(P-256 私钥 PEM 或路径)', null))
    return null
  }
  const eec = resolveEecCertPath(root, options)
  if (!eec.exists) {
    problems.push(
      problem('error', 'EEC_MISSING', '缺少终端签名证书 ' + eec.candidates[0].rel + ',无法签名', eec.candidates[0].rel),
    )
    return null
  }
  if (eec.isPlaceholder) {
    problems.push(problem('error', 'EEC_PLACEHOLDER', '拒绝签名:' + placeholderEecNotice(eec), eec.rel))
    return null
  }
  // 旧布局提示统一由 verifyCollection 给出,这里不重复报,免得同一条警告出现两次。
  const eecPath = eec.path
  let keyFile
  try {
    keyFile = resolveKeyFile(source, 'EEC_SECRET_KEY')
  } catch (error) {
    problems.push(problem('error', 'SIGN_KEY_INVALID', 'EEC 私钥不可用:' + error.message, null))
    return null
  }
  try {
    if (!certMatchesKey(eecPath, keyFile.path)) {
      problems.push(
        problem(
          'error',
          'SIGN_KEY_MISMATCH',
          'EEC_SECRET_KEY 与 ' + eec.rel + ' 不是同一把密钥;请确认证书与 CI secret 配对',
          eec.rel,
        ),
      )
      keyFile.cleanup()
      return null
    }
  } catch (error) {
    problems.push(problem('error', 'SIGN_KEY_INVALID', 'EEC 私钥不可用:' + error.message, null))
    keyFile.cleanup()
    return null
  }
  return { eecPath, keyFile, cleanup: () => keyFile.cleanup() }
}

/** 用 EEC 为每个版本的 plugin.js 生成 CMS 分离签名。meta.json 由 L3 清单覆盖,不再单独签名。 */
function signVersionFiles(root, signer, problems) {
  for (const { versionDir, version } of listVersionDirs(root)) {
    for (const name of VERSION_SIGNED_FILES) {
      const filePath = join(versionDir, name)
      if (!existsSync(filePath)) {
        problems.push(problem('error', 'SIGN_TARGET_MISSING', '版本 ' + version + ' 缺少待签名文件 ' + name, filePath))
        continue
      }
      try {
        signFileCms(filePath, signer.eecPath, signer.keyFile.path)
        problems.push(problem('warning', 'SIGNED', '已用 EEC 为 ' + version + '/' + name + ' 生成 CMS 签名', filePath + '.sig'))
      } catch (error) {
        problems.push(problem('error', 'SIGN_FAILED', '为 ' + version + '/' + name + ' 签名失败:' + error.message, filePath))
      }
    }
  }
}

/** 计算文件的 SHA-512,小写十六进制。 */
function sha512Of(path) {
  return createHash('sha512').update(readFileSync(path)).digest('hex')
}

/** 把层目录内的相对路径列表转成清单条目,按 path 字典序排列,只收实际存在的普通文件。 */
function layerEntries(layerDir, relativePaths) {
  const entries = []
  for (const rel of relativePaths) {
    const filePath = join(layerDir, ...rel.split('/'))
    if (!existsSync(filePath)) continue
    if (!statSync(filePath).isFile()) continue
    entries.push({ path: rel, sha512: sha512Of(filePath) })
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return entries
}

/** 读取该层现有的旧清单,只用于沿用 revision;读不到或结构不对时返回 null。 */
function readPreviousManifest(layerDir) {
  const path = join(layerDir, MANIFEST_FILE)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return isObject(data) && Array.isArray(data.files) ? data : null
  } catch {
    return null
  }
}

/** 旧清单记录的文件集合与哈希是否与新算出的完全一致。 */
function sameEntries(previous, entries) {
  if (!previous) return false
  if (previous.files.length !== entries.length) return false
  const recorded = new Map()
  for (const item of previous.files) {
    if (isObject(item) && typeof item.path === 'string') recorded.set(item.path, item.sha512)
  }
  return entries.every((item) => recorded.get(item.path) === item.sha512)
}

/**
 * 写一层清单并按需签名。
 * revision:文件集合与哈希都没变时沿用旧值,有变化时加一,没有旧清单时从 1 开始。
 * 没有可用私钥时,内容一旦变化就删掉失效的旧签名,避免分发一份必然验不过的清单。
 */
function writeLayerManifest({ layer, layerRel, layerDir, entries, signer, problems }) {
  const previous = readPreviousManifest(layerDir)
  const unchanged = sameEntries(previous, entries)
  const previousRevision = previous && Number.isInteger(previous.revision) && previous.revision > 0 ? previous.revision : null
  let revision = 1
  if (previousRevision !== null) revision = unchanged ? previousRevision : previousRevision + 1
  const manifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, revision, files: entries }
  const manifestPath = join(layerDir, MANIFEST_FILE)
  const text = JSON.stringify(manifest, null, 2) + '\n'
  const previousText = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  const changed = previousText !== text
  if (changed) writeFileSync(manifestPath, text, 'utf8')
  const rel = layerRel ? layerRel + '/' + MANIFEST_FILE : MANIFEST_FILE
  const sigPath = manifestPath + '.sig'
  if (signer) {
    try {
      signManifest(manifestPath, signer.eecPath, signer.keyFile.path)
      problems.push(problem('warning', 'MANIFEST_SIGNED', layer + ' 清单已签名:' + rel, rel + '.sig'))
    } catch (error) {
      problems.push(problem('error', 'MANIFEST_SIGN_FAILED', layer + ' 清单签名失败:' + error.message, rel))
    }
  } else if (changed && existsSync(sigPath)) {
    rmSync(sigPath, { force: true })
    problems.push(
      problem('warning', 'MANIFEST_SIG_REMOVED', layer + ' 清单内容已变化,已删除失效的 ' + rel + '.sig;请用 --sign 重新签名', rel + '.sig'),
    )
  }
  return { layer, dir: layerRel || '.', revision, files: entries.length, changed }
}

/** 生成三层清单:L1 合集根、L2 每个作者目录、L3 每个插件目录,互不引用。 */
function buildManifests(root, signer, problems) {
  const layers = [{ layer: 'L1', layerRel: '', layerDir: root, files: [...LAYER1_FILES, ...LAYER1_OPTIONAL_FILES] }]
  const pluginsDir = join(root, 'plugins')
  for (const author of listDirectoryNames(pluginsDir)) {
    const authorDir = join(pluginsDir, author)
    const authorRel = 'plugins/' + author
    layers.push({ layer: 'L2', layerRel: authorRel, layerDir: authorDir, files: LAYER2_FILES })
    for (const plugin of listDirectoryNames(authorDir)) {
      const pluginDir = join(authorDir, plugin)
      const files = [...LAYER3_FILES]
      for (const version of readVersionList(join(pluginDir, 'versions.json'))) files.push(version + '/meta.json')
      layers.push({ layer: 'L3', layerRel: authorRel + '/' + plugin, layerDir: pluginDir, files })
    }
  }
  const summaries = []
  for (const layer of layers) {
    const entries = layerEntries(layer.layerDir, layer.files)
    summaries.push(writeLayerManifest({ ...layer, entries, signer, problems }))
  }
  return summaries
}

function copyTree(srcDir, destDir) {
  if (!existsSync(srcDir)) return 0
  mkdirSync(destDir, { recursive: true })
  let count = 0
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      count += copyTree(src, dest)
    } else if (entry.isFile()) {
      copyFileSync(src, dest)
      count += 1
    }
  }
  return count
}

/** 按插件目录索引汇总每个插件的版本情况,写入分发内容的 build-info.json。 */
function collectIndex(root) {
  const index = []
  for (const entry of readPluginsIndex(root)) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.plugin_name !== 'string' || typeof entry.author !== 'string') continue
    const dirName = entry.plugin_name.split('/').pop()
    const versionsPath = join(root, 'plugins', entry.author, dirName, 'versions.json')
    let latest = null
    let versions = []
    if (existsSync(versionsPath)) {
      try {
        const data = readJson(versionsPath)
        latest = typeof data.latest === 'string' ? data.latest : null
        versions = Array.isArray(data.versions) ? data.versions : []
      } catch {
        latest = null
        versions = []
      }
    }
    index.push({ name: entry.plugin_name, author: entry.author, latest, versions })
  }
  return index
}

/** 读取分发内容里终端签名证书的指纹。证书位置与校验阶段用同一套解析,不重复推导。 */
function readEecFingerprint(root, options = {}) {
  const eec = resolveEecCertPath(root, options)
  // 占位文件不是证书,读不出指纹:build-info.json 的 eec_sha256 记为 null,由校验阶段报 EEC_PLACEHOLDER。
  if (!eec.exists || eec.isPlaceholder) return null
  try {
    return describeCertificate(eec.path).fingerprint
  } catch {
    return null
  }
}

function writeDist(root, outDir, collectionName) {
  if (resolve(outDir) === resolve(root)) throw new Error('输出目录不能与合集根目录相同')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  let files = 0
  for (const name of ROOT_DIST_FILES) {
    const src = join(root, name)
    if (!existsSync(src)) continue
    copyFileSync(src, join(outDir, name))
    files += 1
  }
  // 终端签名证书所在的整个 certs/ 目录原样复制:目录里除合集自身的 <合集 id>/<合集 id>-eec.crt ,
  // 还可能有其他来源的证书与轮换中的证书,只挑单个文件名会在改名或轮换时漏发,
  // 客户端随后便拿不到能验签的证书。
  // 骨架模式下占位文件也会一起复制,那是本地试跑用的临时产物,发布前必须先换成真实证书。
  files += copyTree(join(root, EEC_CERT_DIR), join(outDir, EEC_CERT_DIR))
  // 旧布局回退:根目录仍有 eec.pem 时一并分发,旧的验签方才能按老路径取到证书;回退删除后这段一起删。
  if (existsSync(join(root, EEC_CERT_FILE))) {
    copyFileSync(join(root, EEC_CERT_FILE), join(outDir, EEC_CERT_FILE))
    files += 1
  }
  files += copyTree(join(root, 'plugins'), join(outDir, 'plugins'))
  const index = collectIndex(root)
  const info = {
    collection: collectionName,
    plugin_count: index.length,
    author_count: new Set(index.map((item) => item.author)).size,
    eec_sha256: readEecFingerprint(root, { collectionName }),
    plugins: index,
  }
  writeFileSync(join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8')
  files += 1
  return { files, info }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('构建失败:' + error.message + '\n\n')
    usage()
    return 2
  }
  if (options.help) {
    usage()
    return 0
  }

  try {
    requireOpenssl()
  } catch (error) {
    process.stderr.write('构建失败:' + error.message + '\n')
    return 2
  }

  const root = resolve(options.dir)
  const outDir = resolve(options.out)
  const problems = []

  const signer = options.sign ? prepareSigner(root, problems, { collectionName: options.collectionName }) : null
  let manifests = []
  try {
    if (signer) signVersionFiles(root, signer, problems)
    manifests = buildManifests(root, signer, problems)
  } finally {
    if (signer) signer.cleanup()
  }

  const rootCaPath = resolveRootCaPath(options)
  const result = verifyCollection(root, {
    rootCaPath,
    allowPlaceholderEec: options.allowPlaceholderEec,
    collectionName: options.collectionName,
  })
  const allProblems = [...problems, ...result.problems]
  const errors = allProblems.filter((item) => item.level === 'error')
  const warnings = allProblems.filter((item) => item.level === 'warning')

  if (errors.length > 0) {
    process.stderr.write('合集校验未通过,共 ' + errors.length + ' 个错误:' + '\n')
    process.stderr.write(formatProblems(allProblems) + '\n')
    return 1
  }

  for (const item of manifests) {
    process.stdout.write(
      item.layer + ' 清单 ' + item.dir + '/' + MANIFEST_FILE +
      ' revision=' + item.revision +
      ',覆盖 ' + item.files + ' 个文件' +
      (item.changed ? '(已更新)' : '(未变化)') + '\n',
    )
  }
  const dist = writeDist(root, outDir, result.collectionName)
  process.stdout.write(
    '合集 ' + result.collectionName + ' 校验通过:' +
    result.stats.authors + ' 个作者,' +
    result.stats.plugins + ' 个插件,' +
    result.stats.versions + ' 个版本' + '\n',
  )
  if (warnings.length > 0) {
    process.stdout.write('警告 ' + warnings.length + ' 条:' + '\n')
    process.stdout.write(formatProblems(warnings) + '\n')
  }
  process.stdout.write('分发内容已写入 ' + outDir + ',共 ' + dist.files + ' 个文件' + '\n')
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write('构建失败:' + (error && error.message ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
