#!/usr/bin/env node
/**
 * 校验合集并生成分发内容。
 *
 * 校验不通过时以非零退出码结束,并列出全部问题。校验通过后把根目录元数据、公钥、签名与
 * plugins/ 目录复制到输出目录,并写入 build-info.json 作为分发索引。
 *
 * 用法:
 *   node scripts/build-collection.mjs --dir . --out dist
 *   node scripts/build-collection.mjs --dir . --sign --out dist
 *   node scripts/build-collection.mjs --dir . --trust-public-key dsc.pub
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { derivePublicKey, mergeSignFile, readSignFile, signFilesInDir, writeSignFile } from './sign.mjs'
import { VERSION_SIGNED_FILES, formatProblems, resolveTrustPublicKeyPem, verifyCollection } from './lib/collection-verify.mjs'

const ROOT_DIST_FILES = ['meta.json', 'plugin_set_sign.json', 'plugin_secret.pub', 'datalog.json', 'tags.json']

function usage() {
  process.stdout.write([
    '用法: node scripts/build-collection.mjs [选项]',
    '',
    '选项:',
    '  --dir <目录>                合集根目录,默认当前目录',
    '  --out <目录>                分发内容输出目录,默认 dist',
    '  --trust-public-key <值>     dsc 信任公钥,可为 PEM 文本或文件路径',
    '  --allow-empty-trust-sign    允许合集尚无 dsc 信任签名(骨架与引导阶段)',
    '  --sign                      用 PLUGIN_PRIVATE_KEY 为插件重新签名',
    '  --private-key <值>          合集私钥 PEM 文本或文件路径,默认读环境变量 PLUGIN_PRIVATE_KEY',
    '  --collection-name <名称>    合集名称,默认取合集目录名',
    '  --help                      显示本说明',
    '',
    '环境变量:',
    '  DSC_PUBLIC_KEY 或 DSC_PUBLIC_KEY_PATH   dsc 信任公钥',
    '  DSC_PRIVATE_KEY 或 WEB_PRIVATE_KEY      dsc 信任私钥,公钥由其推导',
    '  PLUGIN_PRIVATE_KEY                      合集签名私钥',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = {
    dir: '.',
    out: 'dist',
    trustPublicKey: null,
    allowEmptyTrustSign: false,
    sign: false,
    privateKey: null,
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
      case '--trust-public-key': options.trustPublicKey = take(); break
      case '--allow-empty-trust-sign': options.allowEmptyTrustSign = true; break
      case '--sign': options.sign = true; break
      case '--private-key': options.privateKey = take(); break
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

function readKeySource(source) {
  return source.includes('-----BEGIN') ? source : readFileSync(resolve(source), 'utf8')
}

function normalizePem(text) {
  return text.replace(/\r\n/g, '\n').trim()
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function listVersionDirs(root) {
  const datalogPath = join(root, 'datalog.json')
  if (!existsSync(datalogPath)) return []
  let datalog
  try {
    datalog = readJson(datalogPath)
  } catch {
    return []
  }
  if (!Array.isArray(datalog)) return []
  const found = []
  for (const entry of datalog) {
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

function signCollection(root, options, problems) {
  const signer = options.collectionName || basename(root)
  const source = options.privateKey || process.env.PLUGIN_PRIVATE_KEY
  if (!source) {
    problems.push(problem('error', 'SIGN_KEY_MISSING', '启用 --sign 时需要环境变量 PLUGIN_PRIVATE_KEY 或参数 --private-key', null))
    return
  }
  let privateKeyPem
  let publicKeyPem
  try {
    privateKeyPem = readKeySource(source)
    publicKeyPem = derivePublicKey(privateKeyPem)
  } catch (error) {
    problems.push(problem('error', 'SIGN_KEY_INVALID', '合集私钥不可用:' + error.message, null))
    return
  }

  const pubPath = join(root, 'plugin_secret.pub')
  if (!existsSync(pubPath)) {
    writeFileSync(pubPath, publicKeyPem, 'utf8')
    problems.push(problem('warning', 'SIGN_PUB_CREATED', '已由合集私钥生成 plugin_secret.pub,需要 dsc 对该文件签发合集信任签名', 'plugin_secret.pub'))
  } else if (normalizePem(readFileSync(pubPath, 'utf8')) !== normalizePem(publicKeyPem)) {
    problems.push(
      problem(
        'error',
        'SIGN_KEY_MISMATCH',
        'PLUGIN_PRIVATE_KEY 推导的公钥与仓库中的 plugin_secret.pub 不一致;更换合集密钥会让 dsc 已签发的信任签名全部失效',
        'plugin_secret.pub',
      ),
    )
    return
  }

  for (const { versionDir, version } of listVersionDirs(root)) {
    const signPath = join(versionDir, 'plugin_sign.json')
    let existing = { sign: [] }
    if (existsSync(signPath)) {
      try {
        existing = readSignFile(signPath)
      } catch (error) {
        problems.push(problem('error', 'PLUGIN_SIGN_INVALID', error.message, signPath))
        continue
      }
    }
    const entries = signFilesInDir(versionDir, VERSION_SIGNED_FILES, privateKeyPem, signer)
    writeSignFile(signPath, mergeSignFile(existing, entries))
    problems.push(problem('warning', 'SIGNED', '已用签名者 ' + signer + ' 为 ' + version + ' 签名', versionDir))
  }
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

function collectIndex(root) {
  const datalogPath = join(root, 'datalog.json')
  if (!existsSync(datalogPath)) return []
  let datalog
  try {
    datalog = readJson(datalogPath)
  } catch {
    return []
  }
  if (!Array.isArray(datalog)) return []
  const index = []
  for (const entry of datalog) {
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
  files += copyTree(join(root, 'plugins'), join(outDir, 'plugins'))
  const index = collectIndex(root)
  const info = {
    collection: collectionName,
    plugin_count: index.length,
    author_count: new Set(index.map((item) => item.author)).size,
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

  const root = resolve(options.dir)
  const outDir = resolve(options.out)
  const problems = []

  if (options.sign) signCollection(root, options, problems)

  let trustPublicKeyPem = null
  try {
    trustPublicKeyPem = resolveTrustPublicKeyPem({ trustPublicKey: options.trustPublicKey })
  } catch (error) {
    problems.push(problem('error', 'TRUST_KEY_UNREADABLE', 'dsc 信任公钥不可用:' + error.message, null))
  }

  const result = verifyCollection(root, {
    trustPublicKeyPem,
    allowEmptyTrustSign: options.allowEmptyTrustSign,
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
  process.stderr.write('构建失败:' + error.message + '\n')
  process.exitCode = 1
}
