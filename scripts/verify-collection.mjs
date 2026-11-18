#!/usr/bin/env node
/**
 * 合集自洽性校验,供 CI 与开发者本地使用。
 *
 * 与 build-collection.mjs 共用同一套校验逻辑,区别在于只读不写。
 *
 * 用法:
 *   node scripts/verify-collection.mjs --dir .
 *   node scripts/verify-collection.mjs --dir . --trust-public-key dsc.pub
 */
import { formatProblems, resolveTrustPublicKeyPem, verifyCollection } from './lib/collection-verify.mjs'

function usage() {
  process.stdout.write([
    '用法: node scripts/verify-collection.mjs [选项]',
    '',
    '选项:',
    '  --dir <目录>                合集根目录,默认当前目录',
    '  --trust-public-key <值>     dsc 信任公钥,可为 PEM 文本或文件路径',
    '  --allow-empty-trust-sign    允许合集尚无 dsc 信任签名(骨架与引导阶段)',
    '  --collection-name <名称>    合集名称,默认取合集目录名',
    '  --json                      以 JSON 输出校验结果',
    '  --help                      显示本说明',
    '',
    '环境变量:',
    '  DSC_PUBLIC_KEY 或 DSC_PUBLIC_KEY_PATH   dsc 信任公钥',
    '  DSC_PRIVATE_KEY 或 WEB_PRIVATE_KEY      dsc 信任私钥,公钥由其推导',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { dir: '.', trustPublicKey: null, allowEmptyTrustSign: false, collectionName: null, json: false, help: false }
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
      case '--trust-public-key': options.trustPublicKey = take(); break
      case '--allow-empty-trust-sign': options.allowEmptyTrustSign = true; break
      case '--collection-name': options.collectionName = take(); break
      case '--json': options.json = true; break
      case '--help':
      case '-h': options.help = true; break
      default: throw new Error('未知参数 ' + arg)
    }
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('校验失败:' + error.message + '\n\n')
    usage()
    return 2
  }
  if (options.help) {
    usage()
    return 0
  }

  let trustPublicKeyPem = null
  let trustKeyError = null
  try {
    trustPublicKeyPem = resolveTrustPublicKeyPem({ trustPublicKey: options.trustPublicKey })
  } catch (error) {
    trustKeyError = error.message
  }

  const result = verifyCollection(options.dir, {
    trustPublicKeyPem,
    allowEmptyTrustSign: options.allowEmptyTrustSign,
    collectionName: options.collectionName,
  })
  const problems = trustKeyError
    ? [{ level: 'error', code: 'TRUST_KEY_UNREADABLE', message: 'dsc 信任公钥不可用:' + trustKeyError, path: null }, ...result.problems]
    : result.problems

  if (options.json) {
    process.stdout.write(JSON.stringify({ ...result, problems, ok: result.ok && !trustKeyError }, null, 2) + '\n')
  } else if (problems.length === 0) {
    process.stdout.write(
      '合集 ' + result.collectionName + ' 校验通过:' +
      result.stats.authors + ' 个作者,' +
      result.stats.plugins + ' 个插件,' +
      result.stats.versions + ' 个版本' + '\n',
    )
  } else {
    process.stdout.write(formatProblems(problems) + '\n')
    if (result.ok && !trustKeyError) {
      process.stdout.write(
        '合集 ' + result.collectionName + ' 校验通过,含 ' + problems.length + ' 条警告:' +
        result.stats.authors + ' 个作者,' +
        result.stats.plugins + ' 个插件,' +
        result.stats.versions + ' 个版本' + '\n',
      )
    }
  }

  return result.ok && !trustKeyError ? 0 : 1
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write('校验失败:' + error.message + '\n')
  process.exitCode = 1
}
