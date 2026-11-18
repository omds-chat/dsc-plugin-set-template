/**
 * OpenSSL PKI 封装。
 *
 * 本模块只把 OpenSSL 3.0+ 的命令行能力包装成函数,不实现任何密码学运算:
 * 根 CA 生成、终端签名证书(EEC)申请与签发、CMS 分离签名与验签、
 * 作者裸公钥分离签名与验签、证书信息读取与证书链校验,全部交给 openssl 完成。
 *
 * 约定见 .agents/signing-conventions.md:
 * - 根 CA 密钥 ECDSA P-256,自签名,keyUsage=keyCertSign,cRLSign,basicConstraints=CA:TRUE,pathlen:0
 *   (浏览器 WebCrypto 对 P-256 支持最广;证书链校验要在浏览器里做,Ed25519 在目标浏览器下限不可用)
 * - EEC 密钥 ECDSA P-256;OpenSSL 的 CMS 实现对 Ed25519 报 provider signature failure,不可用
 * - EEC 证书 keyUsage=critical,digitalSignature,basicConstraints=critical,CA:FALSE
 * - 合集签名 openssl cms -sign -binary -outform DER -nocerts -noattr,产出逐字节语义的 DER 格式 CMS 分离签名
 *   DER 是跨仓库统一格式:默认的 S/MIME multipart/signed 包装浏览器无法解析,插件市场要在浏览器里验签
 * - 作者签名 openssl pkeyutl -sign -rawin(Ed25519),产出裸公钥分离签名
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 根证书文件名 */
export const ROOT_CA_FILE = 'root_ca.crt'
/** 根 CA 私钥文件名,只在签名环境使用,不入库 */
export const ROOT_CA_KEY_FILE = 'root_secret.pem'
/** 合集根目录的终端签名证书文件名 */
export const EEC_CERT_FILE = 'eec.pem'
/** EEC 私钥文件名,只从 CI secret 读取 */
export const EEC_KEY_FILE = 'eec_secret.pem'
/** EEC 证书签名请求文件名 */
export const EEC_CSR_FILE = 'eec.csr'
/** 作者私钥文件名 */
export const AUTHOR_KEY_FILE = 'author_secret.pem'
/** 作者公钥文件名,随合集分发 */
export const AUTHOR_PUB_FILE = 'author_pub.pem'
/** 版本目录内必须由 EEC 签名的文件 */
export const VERSION_SIGNED_FILES = ['meta.json', 'plugin.js']
/** 需要的最低 OpenSSL 主版本号 */
export const MIN_OPENSSL_MAJOR = 3

const OPENSSL_BIN = process.env.OPENSSL_BIN || 'openssl'
const EEC_EXTENSION_TEXT = 'keyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n'

/** PKI 相关错误。message 面向人阅读,command 与 stderr 保留原始命令输出便于排查。 */
export class PkiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PkiError'
    this.command = details.command || null
    this.stderr = details.stderr || null
  }
}

/** 文件的 CMS 分离签名路径,即 <文件>.sig */
export function cmsSignaturePath(filePath) {
  return filePath + '.sig'
}

/** 文件的作者分离签名路径,即 <文件>.author.sig */
export function authorSignaturePath(filePath) {
  return filePath + '.author.sig'
}

function head(text, lines = 3) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(' ')
}

function run(args, options = {}) {
  const allowFailure = options.allowFailure === true
  try {
    const stdout = execFileSync(OPENSSL_BIN, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: true, stdout: String(stdout), stderr: '' }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new PkiError('无法执行 ' + OPENSSL_BIN + ',请确认 OpenSSL 3.0 及以上版本已安装并在 PATH 中')
    }
    const stderr = String((error && error.stderr) || '') || String((error && error.message) || '')
    if (allowFailure) {
      return { ok: false, stdout: String((error && error.stdout) || ''), stderr }
    }
    throw new PkiError('openssl ' + args[0] + ' 执行失败:' + head(stderr), {
      command: 'openssl ' + args.join(' '),
      stderr,
    })
  }
}

function requireFile(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new PkiError(label + ' 路径为空')
  if (!existsSync(path)) throw new PkiError(label + ' 不存在:' + path)
  return path
}

/**
 * 建好输出文件的父目录。实测部分 OpenSSL 构建在 -out 指向不存在的目录时
 * 既不报错也不写文件(退出码 0),因此写盘前必须先建目录,写完再确认产物存在。
 */
function ensureDirFor(filePath) {
  mkdirSync(dirname(resolve(filePath)), { recursive: true })
}

function requireOutput(filePath, label) {
  if (!existsSync(filePath)) {
    throw new PkiError('openssl 未生成' + label + ':' + filePath + '(输出目录不可写或路径无效)')
  }
  return filePath
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new PkiError(label + ' 必须是非空字符串')
  if (/[\/]/.test(value)) throw new PkiError(label + ' 不得包含斜杠:' + value)
  return value.trim()
}

/** 读取 OpenSSL 版本。未安装时抛 PkiError。 */
export function opensslVersion() {
  let stdout
  try {
    stdout = execFileSync(OPENSSL_BIN, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new PkiError('无法执行 ' + OPENSSL_BIN + ',请确认 OpenSSL 3.0 及以上版本已安装并在 PATH 中')
  }
  const text = String(stdout).trim()
  const match = text.match(/OpenSSL\s+(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new PkiError('无法解析 OpenSSL 版本输出:' + text)
  return { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** 校验 OpenSSL 主版本,低于 3.0 时抛 PkiError。 */
export function requireOpenssl() {
  const version = opensslVersion()
  if (version.major < MIN_OPENSSL_MAJOR) {
    throw new PkiError('需要 OpenSSL ' + MIN_OPENSSL_MAJOR + '.0 及以上,当前为 ' + version.text)
  }
  return version
}

/**
 * 把「PEM 文本或文件路径」统一成文件路径。PEM 文本会落到临时目录,用完调用 cleanup。
 * @param {string} source PEM 文本或路径
 * @param {string} label 用于报错的名称
 * @returns {{path: string, temporary: boolean, cleanup: function(): void}}
 */
export function resolveKeyFile(source, label = '私钥') {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new PkiError(label + ' 为空,请通过参数或环境变量提供 PEM 文本或文件路径')
  }
  if (source.includes('-----BEGIN')) {
    const dir = mkdtempSync(join(tmpdir(), 'dsc-pki-key-'))
    const path = join(dir, 'key.pem')
    writeFileSync(path, source.endsWith('\n') ? source : source + '\n', 'utf8')
    return { path, temporary: true, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }
  const path = resolve(source)
  if (!existsSync(path)) throw new PkiError(label + ' 文件不存在:' + path)
  return { path, temporary: false, cleanup: () => {} }
}

/**
 * 生成自签名根 CA。ECDSA P-256 私钥 + X.509 自签名证书。
 * 固定 P-256:浏览器 WebCrypto 对 P-256 支持最广,证书链校验要在浏览器里做,
 * Ed25519 在目标浏览器下限不可用,因此根 CA 不能改用 Ed25519。
 * @param {string} dir 输出目录
 * @param {object} [options] org、name、days、keyFile、certFile
 * @returns {{keyPath: string, certPath: string}}
 */
export function genRootCa(dir, options = {}) {
  requireOpenssl()
  const org = requireText(options.org || 'omdsc-dev', '组织名称')
  const name = requireText(options.name || 'omdsc-dev Root CA', '根 CA 名称')
  const days = String(options.days || 3650)
  const keyPath = resolve(dir, options.keyFile || ROOT_CA_KEY_FILE)
  const certPath = resolve(dir, options.certFile || ROOT_CA_FILE)
  ensureDirFor(keyPath)
  ensureDirFor(certPath)
  run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', keyPath])
  requireOutput(keyPath, '根私钥')
  run([
    'req', '-x509', '-new', '-key', keyPath, '-days', days, '-out', certPath,
    '-subj', '/O=' + org + '/CN=' + name,
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
  ])
  requireOutput(certPath, '根证书')
  return { keyPath, certPath }
}

/**
 * 生成 EEC 私钥,固定 ECDSA P-256。
 * @param {string} dir 输出目录
 * @param {object} [options] keyFile
 * @returns {{keyPath: string}}
 */
export function genEecKey(dir, options = {}) {
  requireOpenssl()
  const keyPath = resolve(dir, options.keyFile || EEC_KEY_FILE)
  ensureDirFor(keyPath)
  run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', keyPath])
  requireOutput(keyPath, 'EEC 私钥')
  return { keyPath }
}

/**
 * 用已存在的 EEC 私钥生成证书签名请求。
 * @param {string} dir 私钥所在目录
 * @param {string} commonName 证书 CN,通常取合集名
 * @param {string} [org] 证书 O
 * @param {object} [options] keyFile、csrFile
 * @returns {{csrPath: string, keyPath: string}}
 */
export function genCsr(dir, commonName, org = 'omdsc-dev', options = {}) {
  requireOpenssl()
  const cn = requireText(commonName, 'commonName')
  const o = requireText(org || 'omdsc-dev', '组织名称')
  const keyPath = resolve(dir, options.keyFile || EEC_KEY_FILE)
  requireFile(keyPath, 'EEC 私钥')
  const csrPath = resolve(dir, options.csrFile || EEC_CSR_FILE)
  ensureDirFor(csrPath)
  run(['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', '/O=' + o + '/CN=' + cn])
  requireOutput(csrPath, 'CSR')
  return { csrPath, keyPath }
}

/**
 * 用根 CA 签发 EEC 证书。
 * openssl x509 -req 不支持 -addext,因此扩展写进临时文件后经 -extfile 传入。
 * @param {string} csrPath CSR 路径
 * @param {string} rootCertPath 根证书路径
 * @param {string} rootKeyPath 根私钥路径
 * @param {string} outPath 输出证书路径
 * @param {object} [options] days
 * @returns {string} 输出证书路径
 */
export function issueEec(csrPath, rootCertPath, rootKeyPath, outPath, options = {}) {
  requireOpenssl()
  requireFile(csrPath, 'CSR')
  requireFile(rootCertPath, '根证书')
  requireFile(rootKeyPath, '根私钥')
  const days = String(options.days || 365)
  ensureDirFor(outPath)
  const workDir = mkdtempSync(join(tmpdir(), 'dsc-pki-ext-'))
  const extPath = join(workDir, 'eec.ext')
  writeFileSync(extPath, EEC_EXTENSION_TEXT, 'utf8')
  try {
    run([
      'x509', '-req', '-in', csrPath, '-CA', rootCertPath, '-CAkey', rootKeyPath,
      '-CAcreateserial', '-out', outPath, '-days', days, '-extfile', extPath,
    ])
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
  return requireOutput(outPath, 'EEC 证书')
}

/**
 * 用 EEC 对文件生成 CMS 分离签名,输出到 <文件>.sig。
 * 固定加 -binary:签名与验签都按原始字节处理,不经换行规范化,
 * 与作者裸公钥签名(pkeyutl -rawin)的逐字节语义保持一致。
 * 固定加 -outform DER:默认的 S/MIME multipart/signed 包装浏览器无法解析,
 * 而插件市场要在浏览器里验签,因此 DER 是跨仓库统一格式,验签方必须带 -inform DER。
 * @param {string} filePath 待签名文件
 * @param {string} eecCertPath EEC 证书
 * @param {string} eecKeyPath EEC 私钥
 * @param {object} [options] out 自定义签名路径
 * @returns {string} 签名文件路径
 */
export function signFileCms(filePath, eecCertPath, eecKeyPath, options = {}) {
  requireOpenssl()
  requireFile(filePath, '待签名文件')
  requireFile(eecCertPath, 'EEC 证书')
  requireFile(eecKeyPath, 'EEC 私钥')
  const sigPath = options.out || cmsSignaturePath(filePath)
  ensureDirFor(sigPath)
  run(['cms', '-sign', '-binary', '-outform', 'DER', '-in', filePath, '-out', sigPath, '-signer', eecCertPath, '-inkey', eecKeyPath, '-nocerts', '-noattr'])
  return requireOutput(sigPath, 'CMS 签名')
}

/**
 * 校验 CMS 分离签名。签名产物是 DER 格式,因此固定带 -inform DER;
 * EEC 证书只作为候选签名者证书传入 -certfile,信任锚是根证书。
 * 任何一步失败都不抛错,统一返回 { ok, reason },便于一次性汇总全部问题。
 * @param {string} filePath 被签名文件
 * @param {string} sigPath 签名文件
 * @param {string} rootCertPath 根证书
 * @param {string} eecCertPath EEC 证书
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyFileCms(filePath, sigPath, rootCertPath, eecCertPath) {
  if (!existsSync(filePath)) return { ok: false, reason: '被签名文件不存在:' + filePath }
  if (!existsSync(sigPath)) return { ok: false, reason: '签名文件不存在:' + sigPath }
  if (!existsSync(rootCertPath)) return { ok: false, reason: '根证书不存在:' + rootCertPath }
  if (!existsSync(eecCertPath)) return { ok: false, reason: 'EEC 证书不存在:' + eecCertPath }
  const result = run(
    ['cms', '-verify', '-binary', '-inform', 'DER', '-in', sigPath, '-content', filePath, '-CAfile', rootCertPath, '-certfile', eecCertPath],
    { allowFailure: true },
  )
  if (result.ok) return { ok: true, reason: null }
  return { ok: false, reason: head(result.stderr || result.stdout, 2) || 'openssl cms -verify 失败' }
}

/**
 * 生成作者 Ed25519 密钥对。
 * @param {string} dir 输出目录
 * @param {object} [options] keyFile、pubFile
 * @returns {{keyPath: string, pubPath: string}}
 */
export function genAuthorKey(dir, options = {}) {
  requireOpenssl()
  const keyPath = resolve(dir, options.keyFile || AUTHOR_KEY_FILE)
  const pubPath = resolve(dir, options.pubFile || AUTHOR_PUB_FILE)
  ensureDirFor(keyPath)
  ensureDirFor(pubPath)
  run(['genpkey', '-algorithm', 'ed25519', '-out', keyPath])
  requireOutput(keyPath, '作者私钥')
  run(['pkey', '-in', keyPath, '-pubout', '-out', pubPath])
  requireOutput(pubPath, '作者公钥')
  return { keyPath, pubPath }
}

/**
 * 作者裸公钥分离签名,输出到 <文件>.author.sig。
 * @param {string} filePath 待签名文件
 * @param {string} authorKeyPath 作者私钥
 * @param {object} [options] out 自定义签名路径
 * @returns {string} 签名文件路径
 */
export function signFileAuthor(filePath, authorKeyPath, options = {}) {
  requireOpenssl()
  requireFile(filePath, '待签名文件')
  requireFile(authorKeyPath, '作者私钥')
  const sigPath = options.out || authorSignaturePath(filePath)
  ensureDirFor(sigPath)
  run(['pkeyutl', '-sign', '-rawin', '-inkey', authorKeyPath, '-in', filePath, '-out', sigPath])
  return requireOutput(sigPath, '作者签名')
}

/**
 * 校验作者裸公钥分离签名。
 * @param {string} filePath 被签名文件
 * @param {string} sigPath 签名文件
 * @param {string} authorPubPath 作者公钥
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyFileAuthor(filePath, sigPath, authorPubPath) {
  if (!existsSync(filePath)) return { ok: false, reason: '被签名文件不存在:' + filePath }
  if (!existsSync(sigPath)) return { ok: false, reason: '签名文件不存在:' + sigPath }
  if (!existsSync(authorPubPath)) return { ok: false, reason: '作者公钥不存在:' + authorPubPath }
  const result = run(
    ['pkeyutl', '-verify', '-pubin', '-inkey', authorPubPath, '-rawin', '-in', filePath, '-sigfile', sigPath],
    { allowFailure: true },
  )
  if (result.ok) return { ok: true, reason: null }
  return { ok: false, reason: head(result.stderr || result.stdout, 2) || 'openssl pkeyutl -verify 失败' }
}

/**
 * 用根证书校验某张证书的签发链。等价于 openssl verify -CAfile <根证书> <证书>。
 * @param {string} certPath 待校验证书
 * @param {string} rootCertPath 根证书
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyChain(certPath, rootCertPath) {
  if (!existsSync(certPath)) return { ok: false, reason: '证书不存在:' + certPath }
  if (!existsSync(rootCertPath)) return { ok: false, reason: '根证书不存在:' + rootCertPath }
  const result = run(['verify', '-CAfile', rootCertPath, certPath], { allowFailure: true })
  if (result.ok) return { ok: true, reason: null }
  const text = String(result.stderr || '') + String(result.stdout || '')
  const line = text.split('\n').map((item) => item.trim()).filter((item) => item.startsWith('error') || item.includes('error')).slice(0, 2)
  return { ok: false, reason: line.join(' ') || head(text, 2) || 'openssl verify 失败' }
}

function readKeyUsage(certPath) {
  const result = run(['x509', '-in', certPath, '-noout', '-ext', 'keyUsage'], { allowFailure: true })
  if (!result.ok) return []
  const body = result.stdout.split('\n').slice(1).join(' ')
  return body
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function readBasicConstraints(certPath) {
  const result = run(['x509', '-in', certPath, '-noout', '-ext', 'basicConstraints'], { allowFailure: true })
  if (!result.ok) return { present: false, ca: null, text: null }
  const text = result.stdout.replace(/\s+/g, ' ').trim()
  const match = text.match(/CA\s*:\s*(TRUE|FALSE)/i)
  return { present: true, ca: match ? match[1].toUpperCase() === 'TRUE' : null, text }
}

/**
 * 读取证书的可读信息,供校验脚本输出与判断使用。
 * @param {string} certPath 证书路径
 * @returns {{subject: string|null, issuer: string|null, serial: string|null, notBefore: string|null, notAfter: string|null, fingerprint: string|null, keyUsage: string[], isCa: boolean|null, hasBasicConstraints: boolean, validNow: boolean}}
 */
export function describeCertificate(certPath) {
  requireFile(certPath, '证书')
  const result = run(['x509', '-in', certPath, '-noout', '-subject', '-issuer', '-serial', '-startdate', '-enddate', '-fingerprint', '-sha256'])
  const field = (name) => {
    const match = result.stdout.match(new RegExp('^' + name + '=(.*)$', 'm'))
    return match ? match[1].trim() : null
  }
  const fingerprintLine = field('sha256 Fingerprint')
  const basic = readBasicConstraints(certPath)
  const checkend = run(['x509', '-in', certPath, '-noout', '-checkend', '0'], { allowFailure: true })
  return {
    subject: field('subject'),
    issuer: field('issuer'),
    serial: field('serial'),
    notBefore: field('notBefore'),
    notAfter: field('notAfter'),
    fingerprint: fingerprintLine,
    keyUsage: readKeyUsage(certPath),
    isCa: basic.ca,
    hasBasicConstraints: basic.present,
    validNow: checkend.ok,
  }
}

/** 判断 keyUsage 列表是否包含 digitalSignature。 */
export function hasDigitalSignature(keyUsage) {
  return Array.isArray(keyUsage) && keyUsage.some((item) => item.toLowerCase().replace(/\s+/g, '') === 'digitalsignature')
}

/**
 * 读取公钥的类型与位数,用于要求作者公钥必须是 Ed25519。
 * @param {string} publicKeyPath 公钥路径
 * @returns {{type: string, bits: number|null, firstLine: string}}
 */
export function describePublicKey(publicKeyPath) {
  requireFile(publicKeyPath, '公钥')
  const result = run(['pkey', '-pubin', '-in', publicKeyPath, '-noout', '-text'])
  const firstLine = (result.stdout.split('\n')[0] || '').trim()
  const bitsMatch = result.stdout.match(/Public-Key:\s*\((\d+) bit\)/)
  const isEd25519 = /^ED25519 Public-Key:/i.test(firstLine)
  return {
    type: isEd25519 ? 'ed25519' : bitsMatch ? 'ec' : 'unknown',
    bits: bitsMatch ? Number(bitsMatch[1]) : null,
    firstLine,
  }
}

/**
 * 判断证书公钥与私钥是否配对。签名前用它拦住「用错私钥」的情况。
 * @param {string} certPath 证书路径
 * @param {string} keyPath 私钥路径
 * @returns {boolean}
 */
export function certMatchesKey(certPath, keyPath) {
  requireFile(certPath, '证书')
  requireFile(keyPath, '私钥')
  const certPublic = run(['x509', '-in', certPath, '-noout', '-pubkey']).stdout
  const keyPublic = run(['pkey', '-in', keyPath, '-pubout']).stdout
  const normalize = (text) => text.replace(/\r\n/g, '\n').trim()
  return normalize(certPublic) === normalize(keyPublic)
}

/** 读取 UTF-8 文本文件。 */
export function readTextFile(path) {
  return readFileSync(path, 'utf8')
}

/** 判断路径是否为普通文件。 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
