/**
 * 合集自洽性校验。
 *
 * 校验对象是分发规范 v2 的合集目录结构:根目录信任签名、作者公钥、插件清单、版本目录与逐文件签名。
 * 只读取文件,不修改任何内容;build-collection.mjs 与 verify-collection.mjs 共用本模块。
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  derivePublicKey,
  isValidPublicKey,
  loadPublicKey,
  readSetSignFile,
  readSignFile,
  verifyFile,
} from '../sign.mjs'

/** 版本目录内必需的文件 */
export const VERSION_REQUIRED_FILES = ['meta.json', 'plugin.js', 'plugin_sign.json']
/** 版本目录内必须被 plugin_sign.json 覆盖的文件 */
export const VERSION_SIGNED_FILES = ['meta.json', 'plugin.js']
/** 合集根目录必需的文件 */
export const ROOT_REQUIRED_FILES = ['meta.json', 'plugin_secret.pub', 'plugin_set_sign.json', 'datalog.json']

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const PLUGIN_NAME_PATTERN = /^(?:dsc-[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/dsc-[a-z0-9][a-z0-9._-]*)$/

function looksLikePem(text) {
  return typeof text === 'string' && text.includes('-----BEGIN')
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

function parseJsonFile(path, label, report) {
  let text
  try {
    text = readText(path)
  } catch (error) {
    report.error('FILE_UNREADABLE', label + ' 无法读取:' + error.message, path)
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    report.error('JSON_INVALID', label + ' 不是合法 JSON:' + error.message, path)
    return undefined
  }
}

function loadPublicKeyOrNull(pem, code, label, relativePath, report) {
  if (!isValidPublicKey(pem)) {
    report.error(code, label + ' 不是合法的 SPKI PEM 公钥', relativePath)
    return null
  }
  const key = loadPublicKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') {
    report.error(code, label + ' 的密钥类型为 ' + String(key.asymmetricKeyType) + ',要求 ed25519', relativePath)
    return null
  }
  return key
}

/**
 * 解析 dsc 信任公钥。
 * 优先级:显式参数 > DSC_PUBLIC_KEY > DSC_PUBLIC_KEY_PATH > 由 DSC_PRIVATE_KEY 或 WEB_PRIVATE_KEY 推导。
 * 公钥总是以私钥推导结果为准,因此提供私钥时推导结果优先。
 * @param {object} options 含 trustPublicKey 字段
 * @param {Record<string, string|undefined>} env 环境变量表
 * @returns {string|null} 公钥 PEM,无法解析时返回 null
 */
export function resolveTrustPublicKeyPem(options = {}, env = process.env) {
  const fromValue = (value) => (looksLikePem(value) ? value : readText(resolve(value)))
  if (options.trustPublicKey) return fromValue(options.trustPublicKey)
  if (env.DSC_PUBLIC_KEY) return fromValue(env.DSC_PUBLIC_KEY)
  if (env.DSC_PUBLIC_KEY_PATH) return readText(resolve(env.DSC_PUBLIC_KEY_PATH))
  const privateKey = env.DSC_PRIVATE_KEY || env.WEB_PRIVATE_KEY
  if (privateKey) return derivePublicKey(privateKey)
  return null
}

/**
 * 校验一个合集目录。
 * @param {string} collectionDir 合集根目录
 * @param {object} [options] 选项
 * @param {string|null} [options.trustPublicKeyPem] dsc 信任公钥 PEM
 * @param {boolean} [options.allowEmptyTrustSign] 允许合集尚无信任签名(骨架与引导阶段)
 * @param {string} [options.collectionName] 合集名称,默认取目录名
 * @returns {{ok: boolean, root: string, collectionName: string, errorCount: number, warningCount: number, problems: Array<object>, stats: object}}
 */
export function verifyCollection(collectionDir, options = {}) {
  const root = resolve(collectionDir)
  const problems = []
  const stats = { authors: 0, plugins: 0, versions: 0 }
  const report = {
    error(code, message, path) {
      problems.push({ level: 'error', code, message, path: path ?? null })
    },
    warn(code, message, path) {
      problems.push({ level: 'warning', code, message, path: path ?? null })
    },
  }
  const allowEmptyTrustSign = options.allowEmptyTrustSign === true
  const collectionName = options.collectionName || basename(root)

  const finish = () => {
    const errorCount = problems.filter((item) => item.level === 'error').length
    return {
      ok: errorCount === 0,
      root,
      collectionName,
      errorCount,
      warningCount: problems.length - errorCount,
      problems,
      stats,
    }
  }

  if (!isDirectory(root)) {
    report.error('ROOT_MISSING', '合集目录不存在或不是目录:' + root, root)
    return finish()
  }

  // 一、根目录必需文件与合集元数据
  for (const name of ROOT_REQUIRED_FILES) {
    if (!isFile(join(root, name))) report.error('ROOT_FILE_MISSING', '根目录缺少必需文件 ' + name, name)
  }

  const metaPath = join(root, 'meta.json')
  const collectionMeta = isFile(metaPath) ? parseJsonFile(metaPath, '根目录 meta.json', report) : undefined
  if (isObject(collectionMeta)) {
    if (typeof collectionMeta.DOWNLOAD_COUNT_ENABLE !== 'boolean') {
      report.error('META_FIELD_INVALID', 'meta.json 的 DOWNLOAD_COUNT_ENABLE 必须是布尔值', 'meta.json')
    } else if (collectionMeta.DOWNLOAD_COUNT_ENABLE === true) {
      if (typeof collectionMeta.DOWNLOAD_COUNT_API !== 'string' || collectionMeta.DOWNLOAD_COUNT_API.length === 0) {
        report.error('META_FIELD_INVALID', '启用下载计数时 meta.json 的 DOWNLOAD_COUNT_API 必须是非空字符串', 'meta.json')
      }
      if (typeof collectionMeta.API_NEED_IP !== 'boolean') {
        report.error('META_FIELD_INVALID', '启用下载计数时 meta.json 的 API_NEED_IP 必须是布尔值', 'meta.json')
      }
    }
  } else if (collectionMeta !== undefined) {
    report.error('META_FIELD_INVALID', '根目录 meta.json 的顶层必须是对象', 'meta.json')
  }

  // 二、合集公钥
  const collectionPubPath = join(root, 'plugin_secret.pub')
  let collectionPublicKey = null
  if (isFile(collectionPubPath)) {
    collectionPublicKey = loadPublicKeyOrNull(
      readText(collectionPubPath),
      'COLLECTION_PUB_INVALID',
      'plugin_secret.pub',
      'plugin_secret.pub',
      report,
    )
  }

  // 三、合集信任签名
  const setSignPath = join(root, 'plugin_set_sign.json')
  let trustPublicKey = null
  const trustPublicKeyPem = options.trustPublicKeyPem ?? null
  if (trustPublicKeyPem) {
    trustPublicKey = loadPublicKeyOrNull(trustPublicKeyPem, 'TRUST_KEY_INVALID', 'dsc 信任公钥', null, report)
  }
  if (isFile(setSignPath)) {
    let setSign
    try {
      setSign = readSetSignFile(setSignPath)
    } catch (error) {
      report.error('SET_SIGN_INVALID', error.message, 'plugin_set_sign.json')
    }
    if (setSign) {
      if (setSign.sign.length === 0) {
        const message = 'plugin_set_sign.json 没有任何签名,dsc 无法信任该合集'
        if (allowEmptyTrustSign) report.warn('SET_SIGN_EMPTY', message + '(已按骨架模式放行)', 'plugin_set_sign.json')
        else report.error('SET_SIGN_EMPTY', message, 'plugin_set_sign.json')
      } else if (!trustPublicKey) {
        const message = '未提供 dsc 信任公钥,无法校验合集信任签名,请用 --trust-public-key 或环境变量 DSC_PUBLIC_KEY 提供'
        if (allowEmptyTrustSign) report.warn('TRUST_KEY_MISSING', message, 'plugin_set_sign.json')
        else report.error('TRUST_KEY_MISSING', message, 'plugin_set_sign.json')
      } else if (!isFile(collectionPubPath)) {
        report.error('SET_SIGN_TARGET_MISSING', '信任签名的被签名对象 plugin_secret.pub 不存在', 'plugin_secret.pub')
      } else {
        let valid = 0
        for (const entry of setSign.sign) {
          if (verifyFile(collectionPubPath, entry.value, trustPublicKey)) {
            valid += 1
            if (entry.signer !== 'dsc') {
              report.warn('SET_SIGN_SIGNER', '合集信任签名的签名者为 ' + entry.signer + ',约定应为 dsc', 'plugin_set_sign.json')
            }
          } else {
            report.error(
              'SET_SIGN_INVALID',
              '合集信任签名校验失败,签名者 ' + entry.signer + ',被签名对象为 plugin_secret.pub',
              'plugin_set_sign.json',
            )
          }
        }
        if (valid === 0 && setSign.sign.length > 0 && trustPublicKey) {
          report.error('SET_SIGN_UNTRUSTED', 'plugin_set_sign.json 中没有任何签名能被 dsc 公钥验证', 'plugin_set_sign.json')
        }
      }
    }
  }

  // 四、预设标签
  const tagsPath = join(root, 'tags.json')
  let tagSet = null
  if (isFile(tagsPath)) {
    const tags = parseJsonFile(tagsPath, 'tags.json', report)
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        report.error('TAGS_INVALID', 'tags.json 的顶层必须是字符串数组', 'tags.json')
      } else {
        const seen = new Set()
        for (const [index, tag] of tags.entries()) {
          if (typeof tag !== 'string' || tag.length === 0) {
            report.error('TAGS_INVALID', 'tags.json 第 ' + index + ' 项必须是非空字符串', 'tags.json')
            continue
          }
          if (seen.has(tag)) report.warn('TAGS_DUPLICATE', 'tags.json 存在重复标签 ' + tag, 'tags.json')
          seen.add(tag)
        }
        tagSet = seen
      }
    }
  }

  // 五、插件目录 datalog.json
  const datalogPath = join(root, 'datalog.json')
  const datalog = isFile(datalogPath) ? parseJsonFile(datalogPath, 'datalog.json', report) : undefined
  const entries = []
  if (datalog !== undefined) {
    if (!Array.isArray(datalog)) {
      report.error('DATALOG_INVALID', 'datalog.json 的顶层必须是数组', 'datalog.json')
    } else {
      const seenNames = new Set()
      for (const [index, entry] of datalog.entries()) {
        const label = 'datalog.json 第 ' + index + ' 项'
        if (!isObject(entry)) {
          report.error('DATALOG_INVALID', label + ' 必须是对象', 'datalog.json')
          continue
        }
        if (typeof entry.plugin_name !== 'string' || !PLUGIN_NAME_PATTERN.test(entry.plugin_name)) {
          report.error('DATALOG_INVALID', label + ' 的 plugin_name 不是合法的插件名', 'datalog.json')
          continue
        }
        if (typeof entry.author !== 'string' || entry.author.length === 0) {
          report.error('DATALOG_INVALID', label + ' 的 author 必须是非空字符串', 'datalog.json')
          continue
        }
        if (!Array.isArray(entry.tag) || entry.tag.some((tag) => typeof tag !== 'string' || tag.length === 0)) {
          report.error('DATALOG_INVALID', label + ' 的 tag 必须是字符串数组', 'datalog.json')
          continue
        }
        if (seenNames.has(entry.plugin_name)) {
          report.error('DATALOG_DUPLICATE', '插件名 ' + entry.plugin_name + ' 在 datalog.json 中重复出现', 'datalog.json')
          continue
        }
        seenNames.add(entry.plugin_name)
        if (tagSet) {
          for (const tag of entry.tag) {
            if (!tagSet.has(tag)) {
              report.error(
                'TAG_NOT_DECLARED',
                '插件 ' + entry.plugin_name + ' 的标签 ' + tag + ' 未在 tags.json 中声明',
                'datalog.json',
              )
            }
          }
        }
        entries.push({ plugin_name: entry.plugin_name, author: entry.author, tag: [...entry.tag] })
      }
    }
  }

  // 六、作者清单
  const authorManifestPath = join(root, 'plugins', 'author_manifest.json')
  const registeredAuthors = new Set()
  if (!isFile(authorManifestPath)) {
    report.error('AUTHOR_MANIFEST_MISSING', 'plugins/author_manifest.json 不存在', 'plugins/author_manifest.json')
  } else {
    const manifest = parseJsonFile(authorManifestPath, 'plugins/author_manifest.json', report)
    if (manifest !== undefined) {
      if (!Array.isArray(manifest)) {
        report.error('AUTHOR_MANIFEST_INVALID', 'plugins/author_manifest.json 的顶层必须是数组', 'plugins/author_manifest.json')
      } else {
        for (const [index, item] of manifest.entries()) {
          const label = 'plugins/author_manifest.json 第 ' + index + ' 项'
          if (!isObject(item) || typeof item.username !== 'string' || item.username.length === 0) {
            report.error('AUTHOR_MANIFEST_INVALID', label + ' 缺少合法的 username', 'plugins/author_manifest.json')
            continue
          }
          if (typeof item.profile !== 'string' || item.profile.length === 0) {
            report.error('AUTHOR_MANIFEST_INVALID', label + ' 缺少合法的 profile', 'plugins/author_manifest.json')
          }
          if (registeredAuthors.has(item.username)) {
            report.warn('AUTHOR_MANIFEST_DUPLICATE', '作者 ' + item.username + ' 在 author_manifest.json 中重复登记', 'plugins/author_manifest.json')
          }
          registeredAuthors.add(item.username)
        }
      }
    }
  }

  // 七、逐插件校验
  const authorCache = new Map()
  for (const entry of entries) {
    const author = entry.author
    if (!registeredAuthors.has(author)) {
      report.warn('AUTHOR_NOT_REGISTERED', '作者 ' + author + ' 未在 plugins/author_manifest.json 中登记', 'plugins/author_manifest.json')
    }
    if (!authorCache.has(author)) {
      authorCache.set(author, inspectAuthor({ root, author, report, stats, collectionPublicKey }))
    }
    const authorContext = authorCache.get(author)
    if (!authorContext) continue
    if (!authorContext.manifestPlugins.has(entry.plugin_name)) {
      report.error(
        'PLUGIN_NOT_IN_MANIFEST',
        '插件 ' + entry.plugin_name + ' 未出现在 plugins/' + author + '/plugin_manifest.json 中',
        'plugins/' + author + '/plugin_manifest.json',
      )
    }
    inspectPlugin({ authorContext, entry, report, stats })
  }

  for (const context of authorCache.values()) stats.authors += 1
  return finish()
}

function inspectAuthor({ root, author, report, stats, collectionPublicKey }) {
  const authorRel = 'plugins/' + author
  const authorDir = join(root, 'plugins', author)
  if (!isDirectory(authorDir)) {
    report.error('AUTHOR_DIR_MISSING', '作者目录不存在:' + authorRel, authorRel)
    return null
  }
  const pubPath = join(authorDir, 'plugin_secret.pub')
  let publicKey = null
  if (!isFile(pubPath)) {
    report.error('AUTHOR_PUB_MISSING', '作者公钥不存在:' + authorRel + '/plugin_secret.pub', authorRel + '/plugin_secret.pub')
  } else {
    publicKey = loadPublicKeyOrNull(readText(pubPath), 'AUTHOR_PUB_INVALID', authorRel + '/plugin_secret.pub', authorRel + '/plugin_secret.pub', report)
  }
  const manifestRel = authorRel + '/plugin_manifest.json'
  const manifestPath = join(authorDir, 'plugin_manifest.json')
  const manifestPlugins = new Set()
  if (!isFile(manifestPath)) {
    report.error('PLUGIN_MANIFEST_MISSING', '作者插件清单不存在:' + manifestRel, manifestRel)
  } else {
    const manifest = parseJsonFile(manifestPath, manifestRel, report)
    if (manifest !== undefined) {
      if (!Array.isArray(manifest)) {
        report.error('PLUGIN_MANIFEST_INVALID', manifestRel + ' 的顶层必须是插件名数组', manifestRel)
      } else {
        for (const [index, name] of manifest.entries()) {
          if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
            report.error('PLUGIN_MANIFEST_INVALID', manifestRel + ' 第 ' + index + ' 项不是合法的插件名', manifestRel)
            continue
          }
          manifestPlugins.add(name)
        }
      }
    }
  }
  return { author, authorDir, authorRel, publicKey, manifestPlugins, stats, collectionPublicKey }
}

function inspectPlugin({ authorContext, entry, report, stats }) {
  const { author, authorDir, authorRel, publicKey: authorPublicKey } = authorContext
  const dirName = entry.plugin_name.split('/').pop()
  const pluginRel = authorRel + '/' + dirName
  const pluginDir = join(authorDir, dirName)
  if (!isDirectory(pluginDir)) {
    report.error('PLUGIN_DIR_MISSING', '插件目录不存在:' + pluginRel, pluginRel)
    return
  }
  stats.plugins += 1

  const versionsRel = pluginRel + '/versions.json'
  const versionsPath = join(pluginDir, 'versions.json')
  if (!isFile(versionsPath)) {
    report.error('VERSIONS_MISSING', '插件目录缺少 versions.json:' + versionsRel, versionsRel)
    return
  }
  const versionsData = parseJsonFile(versionsPath, versionsRel, report)
  if (versionsData === undefined) return
  if (!isObject(versionsData)) {
    report.error('VERSIONS_INVALID', versionsRel + ' 的顶层必须是对象', versionsRel)
    return
  }
  const versionList = Array.isArray(versionsData.versions) ? versionsData.versions : null
  if (!versionList || versionList.length === 0) {
    report.error('VERSIONS_INVALID', versionsRel + ' 的 versions 必须是非空数组', versionsRel)
    return
  }
  for (const version of versionList) {
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
      report.error('VERSIONS_INVALID', versionsRel + ' 含非法版本号 ' + JSON.stringify(version), versionsRel)
    }
  }
  if (typeof versionsData.latest !== 'string' || !SEMVER_PATTERN.test(versionsData.latest)) {
    report.error('VERSIONS_INVALID', versionsRel + ' 的 latest 不是合法版本号', versionsRel)
  } else if (!versionList.includes(versionsData.latest)) {
    report.error('LATEST_NOT_LISTED', versionsRel + ' 的 latest ' + versionsData.latest + ' 不在 versions 列表内', versionsRel)
  }

  for (const version of versionList) {
    if (typeof version !== 'string') continue
    const versionRel = pluginRel + '/' + version
    const versionDir = join(pluginDir, version)
    if (!isDirectory(versionDir)) {
      report.error('VERSION_DIR_MISSING', '版本目录不存在:' + versionRel, versionRel)
      continue
    }
    stats.versions += 1
    for (const name of VERSION_REQUIRED_FILES) {
      if (!isFile(join(versionDir, name))) {
        report.error('VERSION_FILE_MISSING', versionRel + ' 缺少必需文件 ' + name, versionRel + '/' + name)
      }
    }
    inspectVersionMeta({ versionDir, versionRel, version, pluginName: entry.plugin_name, report })
    inspectVersionSign({ versionDir, versionRel, author, authorPublicKey, collectionPublicKey: authorContext.collectionPublicKey, report })
  }
}

function inspectVersionMeta({ versionDir, versionRel, version, pluginName, report }) {
  const metaPath = join(versionDir, 'meta.json')
  if (!isFile(metaPath)) return
  const meta = parseJsonFile(metaPath, versionRel + '/meta.json', report)
  if (meta === undefined) return
  if (!isObject(meta)) {
    report.error('PLUGIN_META_INVALID', versionRel + '/meta.json 的顶层必须是对象', versionRel + '/meta.json')
    return
  }
  if (meta.name !== pluginName) {
    report.error('PLUGIN_META_MISMATCH', versionRel + '/meta.json 的 name 为 ' + JSON.stringify(meta.name) + ',与 datalog.json 的 ' + pluginName + ' 不一致', versionRel + '/meta.json')
  }
  if (meta.version !== version) {
    report.error('PLUGIN_META_MISMATCH', versionRel + '/meta.json 的 version 为 ' + JSON.stringify(meta.version) + ',与目录名 ' + version + ' 不一致', versionRel + '/meta.json')
  }
}

function inspectVersionSign({ versionDir, versionRel, author, authorPublicKey, collectionPublicKey, report }) {
  const signPath = join(versionDir, 'plugin_sign.json')
  if (!isFile(signPath)) return
  let signFile
  try {
    signFile = readSignFile(signPath)
  } catch (error) {
    report.error('PLUGIN_SIGN_INVALID', error.message, versionRel + '/plugin_sign.json')
    return
  }
  const covered = new Set(signFile.sign.map((entry) => entry.for))
  for (const name of VERSION_SIGNED_FILES) {
    if (!covered.has(name)) {
      report.error('SIGN_COVERAGE', versionRel + '/plugin_sign.json 未覆盖 ' + name, versionRel + '/plugin_sign.json')
    }
  }
  const collectionEntries = signFile.sign.filter((entry) => entry.signer !== author)
  if (collectionEntries.length === 0) {
    report.error('MISSING_COLLECTION_SIGN', versionRel + '/plugin_sign.json 缺少合集签名,签名者应不等于作者名 ' + author, versionRel + '/plugin_sign.json')
  }
  const collectionPublicKeyResolved = collectionPublicKey ?? null
  for (const entry of signFile.sign) {
    if (entry.for.includes('/') || entry.for.includes('\\')) {
      report.error('SIGN_TARGET_NOT_LOCAL', versionRel + '/plugin_sign.json 的 for 必须是同目录文件名,实际为 ' + entry.for, versionRel + '/plugin_sign.json')
      continue
    }
    const targetPath = join(versionDir, entry.for)
    if (!isFile(targetPath)) {
      report.error('SIGN_TARGET_MISSING', versionRel + '/plugin_sign.json 引用了不存在的文件 ' + entry.for, versionRel + '/' + entry.for)
      continue
    }
    const isAuthorSign = entry.signer === author
    const primaryKey = isAuthorSign ? authorPublicKey : collectionPublicKeyResolved
    const fallbackKey = isAuthorSign ? collectionPublicKeyResolved : authorPublicKey
    const label = versionRel + '/plugin_sign.json 中签名者 ' + entry.signer + ' 对 ' + entry.for + ' 的签名'
    if (primaryKey && verifyFile(targetPath, entry.value, primaryKey)) continue
    if (!primaryKey && !fallbackKey) {
      report.warn('SIGN_UNVERIFIABLE', label + ' 无法校验,缺少可用公钥', versionRel + '/plugin_sign.json')
      continue
    }
    if (fallbackKey && verifyFile(targetPath, entry.value, fallbackKey)) {
      report.warn(
        'SIGN_KEY_FALLBACK',
        label + ' 由非预期公钥验证通过(按签名者应为' + (isAuthorSign ? '作者公钥' : '合集公钥') + ')',
        versionRel + '/plugin_sign.json',
      )
      continue
    }
    report.error('SIGN_VERIFY_FAILED', label + ' 校验失败,文件内容可能已被篡改', versionRel + '/plugin_sign.json')
  }
}

/**
 * 把问题列表格式化为可读文本。
 * @param {Array<object>} problems 问题列表
 * @returns {string}
 */
export function formatProblems(problems) {
  return problems
    .map((item) => {
      const level = item.level === 'error' ? '[错误]' : '[警告]'
      const location = item.path ? ' (' + item.path + ')' : ''
      return level + ' ' + item.code + ' ' + item.message + location
    })
    .join('\n')
}
