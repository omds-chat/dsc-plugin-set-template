/**
 * Ed25519 hash-then-sign 签名工具。
 *
 * 约定:先对文件字节做 SHA-512 摘要,再对摘要字节签名,签名以 base64 编码。
 * 私钥为 PKCS#8 PEM,公钥为 SPKI PEM。本模块只做字节层面的运算,不假设任何仓库结构,
 * 因此可被插件合集、插件构建脚本与网页签名流程共用。
 */
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 摘要算法标识 */
export const DIGEST_ALGORITHM = 'sha512'
/** 签名算法标识 */
export const SIGN_ALGORITHM = 'ed25519'
/** 插件签名的文件名 */
export const PLUGIN_SIGN_FILE = 'plugin_sign.json'
/** 合集信任签名的文件名 */
export const PLUGIN_SET_SIGN_FILE = 'plugin_set_sign.json'

function toBuffer(input, label) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  throw new TypeError(label + ' 必须是 Buffer、Uint8Array 或字符串')
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(label + ' 必须是非空字符串')
  }
  return value
}

function looksLikePem(text) {
  return typeof text === 'string' && text.includes('-----BEGIN')
}

/**
 * 载入 PKCS#8 PEM 私钥。
 * @param {string|Buffer} pem 私钥 PEM 文本
 * @returns {import('node:crypto').KeyObject}
 */
export function loadPrivateKey(pem) {
  const text = toBuffer(pem, '私钥').toString('utf8')
  if (!looksLikePem(text)) throw new Error('私钥不是 PEM 格式,期望 PKCS#8 PEM')
  return createPrivateKey({ key: text, format: 'pem' })
}

/**
 * 载入 SPKI PEM 公钥。
 * @param {string|Buffer} pem 公钥 PEM 文本
 * @returns {import('node:crypto').KeyObject}
 */
export function loadPublicKey(pem) {
  const text = toBuffer(pem, '公钥').toString('utf8')
  if (!looksLikePem(text)) throw new Error('公钥不是 PEM 格式,期望 SPKI PEM')
  return createPublicKey({ key: text, format: 'pem' })
}

/**
 * 由私钥推导公钥 PEM。公钥总是以私钥推导结果为准。
 * @param {string|Buffer|import('node:crypto').KeyObject} pem 私钥 PEM 文本或私钥对象
 * @returns {string} SPKI PEM 公钥文本
 */
export function derivePublicKey(pem) {
  const privateKey = typeof pem === 'object' && pem !== null && pem.type === 'private'
    ? pem
    : loadPrivateKey(pem)
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
}

/**
 * 计算 SHA-512 摘要。
 * @param {Buffer|Uint8Array|string} buffer 待摘要字节
 * @returns {Buffer}
 */
export function digestSha512(buffer) {
  return createHash(DIGEST_ALGORITHM).update(toBuffer(buffer, '摘要输入')).digest()
}

/**
 * 对字节的 SHA-512 摘要签名。
 * @param {Buffer|Uint8Array|string} buffer 待签名字节
 * @param {string|Buffer|import('node:crypto').KeyObject} privateKeyPem 私钥 PEM 或私钥对象
 * @returns {string} base64 签名
 */
export function signDigest(buffer, privateKeyPem) {
  const privateKey = typeof privateKeyPem === 'object' && privateKeyPem !== null && privateKeyPem.type === 'private'
    ? privateKeyPem
    : loadPrivateKey(privateKeyPem)
  return signBytes(null, digestSha512(buffer), privateKey).toString('base64')
}

/**
 * 签名单个文件,返回一条签名条目。for 字段取文件名。
 * @param {string} filePath 文件路径
 * @param {string|Buffer|import('node:crypto').KeyObject} privateKeyPem 私钥 PEM 或私钥对象
 * @param {string} signer 签名者标识
 * @returns {{value: string, for: string, signer: string}}
 */
export function signFile(filePath, privateKeyPem, signer) {
  requireText(filePath, '文件路径')
  requireText(signer, '签名者标识')
  return {
    value: signDigest(readFileSync(filePath), privateKeyPem),
    for: basename(filePath),
    signer,
  }
}

/**
 * 校验单个文件的签名。签名不匹配返回 false;公钥本身不可用则抛错。
 * @param {string} filePath 文件路径
 * @param {string} signatureBase64 base64 签名
 * @param {string|Buffer|import('node:crypto').KeyObject} publicKeyPem 公钥 PEM 或公钥对象
 * @returns {boolean}
 */
export function verifyFile(filePath, signatureBase64, publicKeyPem) {
  const publicKey = typeof publicKeyPem === 'object' && publicKeyPem !== null && publicKeyPem.type === 'public'
    ? publicKeyPem
    : loadPublicKey(publicKeyPem)
  if (typeof signatureBase64 !== 'string' || signatureBase64.length === 0) return false
  let signature
  try {
    signature = Buffer.from(signatureBase64, 'base64')
  } catch {
    return false
  }
  if (signature.length === 0) return false
  return verifyBytes(null, digestSha512(readFileSync(filePath)), publicKey, signature)
}

/**
 * 判断一段文本是否为可解析的公钥 PEM。
 * @param {string|Buffer} pem 公钥 PEM 文本
 * @returns {boolean}
 */
export function isValidPublicKey(pem) {
  try {
    loadPublicKey(pem)
    return true
  } catch {
    return false
  }
}

function normalizeSignEntries(entries, { requireFor }) {
  if (!Array.isArray(entries)) throw new TypeError('签名条目必须是数组')
  return entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError('签名条目 ' + index + ' 必须是对象')
    }
    const value = requireText(entry.value, '签名条目 ' + index + ' 的 value')
    const signer = requireText(entry.signer, '签名条目 ' + index + ' 的 signer')
    if (!requireFor) return { value, signer }
    const target = requireText(entry.for, '签名条目 ' + index + ' 的 for')
    return { value, for: target, signer }
  })
}

/**
 * 构造带 for 字段的签名文件结构,即 plugin_sign.json 的内容。
 * @param {Array<{value: string, for: string, signer: string}>} entries 签名条目
 * @returns {{sign: Array<{value: string, for: string, signer: string}>}}
 */
export function buildSignFile(entries) {
  return { sign: normalizeSignEntries(entries, { requireFor: true }) }
}

/**
 * 构造不带 for 字段的信任签名文件结构,即 plugin_set_sign.json 的内容。
 * @param {Array<{value: string, signer: string}>} entries 签名条目
 * @returns {{sign: Array<{value: string, signer: string}>}}
 */
export function buildSetSignFile(entries) {
  return { sign: normalizeSignEntries(entries, { requireFor: false }) }
}

function readJsonFile(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error('无法读取' + label + ' ' + path + ':' + error.message)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(label + ' ' + path + ' 不是合法 JSON:' + error.message)
  }
}

/**
 * 读取并校验 plugin_sign.json 结构。
 * @param {string} path 文件路径
 * @returns {{sign: Array<{value: string, for: string, signer: string}>}}
 */
export function readSignFile(path) {
  const data = readJsonFile(path, '签名文件')
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('签名文件 ' + path + ' 的顶层必须是对象')
  }
  if (!('sign' in data)) throw new Error('签名文件 ' + path + ' 缺少 sign 字段')
  for (const key of Object.keys(data)) {
    if (key !== 'sign') throw new Error('签名文件 ' + path + ' 含未定义字段 ' + key)
  }
  return { sign: normalizeSignEntries(data.sign, { requireFor: true }) }
}

/**
 * 读取并校验 plugin_set_sign.json 结构。
 * @param {string} path 文件路径
 * @returns {{sign: Array<{value: string, signer: string}>}}
 */
export function readSetSignFile(path) {
  const data = readJsonFile(path, '信任签名文件')
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('信任签名文件 ' + path + ' 的顶层必须是对象')
  }
  if (!('sign' in data)) throw new Error('信任签名文件 ' + path + ' 缺少 sign 字段')
  for (const key of Object.keys(data)) {
    if (key !== 'sign') throw new Error('信任签名文件 ' + path + ' 含未定义字段 ' + key)
  }
  return { sign: normalizeSignEntries(data.sign, { requireFor: false }) }
}

/**
 * 写入签名文件,固定两空格缩进并以换行结尾。
 * @param {string} path 目标路径
 * @param {{sign: Array<object>}} data 签名文件结构
 * @returns {void}
 */
export function writeSignFile(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/**
 * 对目录内若干文件签名,返回签名条目数组。
 * @param {string} dir 目录
 * @param {string[]} fileNames 目录内的文件名
 * @param {string|Buffer|import('node:crypto').KeyObject} privateKeyPem 私钥 PEM 或私钥对象
 * @param {string} signer 签名者标识
 * @returns {Array<{value: string, for: string, signer: string}>}
 */
export function signFilesInDir(dir, fileNames, privateKeyPem, signer) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) throw new TypeError('fileNames 必须是非空数组')
  return fileNames.map((name) => signFile(resolve(dir, name), privateKeyPem, signer))
}

/**
 * 合并签名条目:同一 signer 对同一 for 的旧条目被替换,其余条目原样保留。
 * 用于在合集签名时保留作者自签名。
 * @param {{sign: Array<object>}} existing 已有签名文件结构
 * @param {Array<{value: string, for: string, signer: string}>} entries 新签名条目
 * @returns {{sign: Array<{value: string, for: string, signer: string}>}}
 */
export function mergeSignFile(existing, entries) {
  const fresh = normalizeSignEntries(entries, { requireFor: true })
  const replaced = new Set(fresh.map((entry) => entry.signer + '\u0000' + entry.for))
  const kept = normalizeSignEntries(existing?.sign ?? [], { requireFor: true })
    .filter((entry) => !replaced.has(entry.signer + '\u0000' + entry.for))
  return buildSignFile([...kept, ...fresh])
}

function readKeyText(source) {
  const text = toBuffer(source, '密钥').toString('utf8')
  return looksLikePem(text) ? text : readFileSync(resolve(text), 'utf8')
}

function printUsage() {
  process.stdout.write([
    '用法:',
    '  node scripts/sign.mjs derive-public-key <私钥路径>',
    '  node scripts/sign.mjs sign <私钥路径> <签名者标识> <文件路径...>',
    '  node scripts/sign.mjs verify <公钥路径> <签名文件路径>',
    '',
  ].join('\n'))
}

function runCli(argv) {
  const [command, ...rest] = argv
  if (command === 'derive-public-key') {
    if (rest.length !== 1) throw new Error('derive-public-key 需要且仅需要一个私钥路径')
    process.stdout.write(derivePublicKey(readKeyText(rest[0])))
    return
  }
  if (command === 'sign') {
    if (rest.length < 3) throw new Error('sign 需要私钥路径、签名者标识与至少一个文件路径')
    const [keyPath, signer, ...files] = rest
    const entries = signFilesInDir(process.cwd(), files, readKeyText(keyPath), signer)
    process.stdout.write(JSON.stringify(buildSignFile(entries), null, 2) + '\n')
    return
  }
  if (command === 'verify') {
    if (rest.length !== 2) throw new Error('verify 需要公钥路径与签名文件路径')
    const publicKey = readKeyText(rest[0])
    const signFile = readSignFile(rest[1])
    let failed = 0
    for (const entry of signFile.sign) {
      const target = resolve(process.cwd(), entry.for)
      const ok = verifyFile(target, entry.value, publicKey)
      process.stdout.write((ok ? '通过 ' : '失败 ') + entry.for + ' (' + entry.signer + ')\n')
      if (!ok) failed += 1
    }
    if (failed > 0) process.exitCode = 1
    return
  }
  printUsage()
  if (command && command !== '--help' && command !== '-h') process.exitCode = 2
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('签名工具出错:' + error.message + '\n')
    process.exitCode = 1
  }
}
