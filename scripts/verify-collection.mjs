#!/usr/bin/env node
/**
 * 合集自洽性校验,供 CI 与开发者本地使用。
 *
 * 与 build-collection.mjs 共用 lib/collection-verify.mjs 的校验逻辑,只读不写。
 * 校验覆盖:证书链、三层哈希清单(存在性、结构、路径、覆盖范围、SHA-512、清单签名)、
 * 版本目录必需文件与 plugin.js.sig、作者签名、标签与插件登记的一致性。
 * 证书链与 CMS 签名校验需要根证书:用 --root-ca 指定,或设置环境变量 ROOT_CA_PATH。
 * 终端签名证书按 certs/<合集 id>-eec.crt 读取,旧的根目录 eec.pem 仅作兼容回退。
 *
 * 用法:
 *   node scripts/verify-collection.mjs --dir . --root-ca root_ca.crt
 *   ROOT_CA_PATH=root_ca.crt node scripts/verify-collection.mjs --dir .
 *   node scripts/verify-collection.mjs --dir template --allow-placeholder-eec
 *   node scripts/verify-collection.mjs --dir . --allow-missing-manifest
 */
import { formatProblems, resolveRootCaPath, verifyCollection } from './lib/collection-verify.mjs'
import { opensslVersion } from './pki.mjs'

function usage() {
  process.stdout.write([
    '用法: node scripts/verify-collection.mjs [选项]',
    '',
    '选项:',
    '  --dir <目录>                合集根目录,默认当前目录',
    '  --root-ca <路径>            根证书路径,用于校验证书链与 CMS 签名',
    '  --allow-placeholder-eec     骨架模式:根证书缺失、终端签名证书未由根 CA 签发、清单或清单签名缺失时只警告',
    '  --allow-missing-manifest    只放开三层清单与清单签名缺失,结构与哈希检查照常执行',
    '  --collection-name <名称>    合集名称,默认取合集目录名;同时决定证书文件名 certs/<合集 id>-eec.crt',
    '  --json                      以 JSON 输出校验结果',
    '  --help                      显示本说明',
    '',
    '环境变量:',
    '  ROOT_CA_PATH                根证书路径,等价于 --root-ca',
    '',
    '终端签名证书按 certs/<合集 id>-eec.crt 读取,旧的根目录 eec.pem 仅作兼容回退。',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = {
    dir: '.',
    rootCa: null,
    allowPlaceholderEec: false,
    allowMissingManifest: false,
    collectionName: null,
    json: false,
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
      case '--root-ca': options.rootCa = take(); break
      case '--allow-placeholder-eec': options.allowPlaceholderEec = true; break
      case '--allow-missing-manifest': options.allowMissingManifest = true; break
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

  try {
    const version = opensslVersion()
    if (version.major < 3) {
      process.stderr.write('校验失败:需要 OpenSSL 3.0 及以上,当前为 ' + version.text + '\n')
      return 2
    }
  } catch (error) {
    process.stderr.write('校验失败:' + error.message + '\n')
    return 2
  }

  const rootCaPath = resolveRootCaPath(options)
  const result = verifyCollection(options.dir, {
    rootCaPath,
    allowPlaceholderEec: options.allowPlaceholderEec,
    allowMissingManifest: options.allowMissingManifest,
    collectionName: options.collectionName,
  })

  if (options.json) {
    process.stdout.write(JSON.stringify({ ...result, rootCaPath }, null, 2) + '\n')
  } else {
    if (result.problems.length > 0) process.stdout.write(formatProblems(result.problems) + '\n')
    for (const item of result.stats.manifests) {
      process.stdout.write(
        '清单 ' + item.layer + ' ' + item.dir + ' revision=' + String(item.revision) + ',覆盖 ' + item.files + ' 个文件' + '\n',
      )
    }
    const summary =
      '合集 ' + result.collectionName + ':' +
      result.stats.authors + ' 个作者,' +
      result.stats.plugins + ' 个插件,' +
      result.stats.versions + ' 个版本,' +
      result.stats.manifests.length + ' 层清单'
    if (result.ok) {
      process.stdout.write('校验通过 ' + summary + ',警告 ' + result.warningCount + ' 条\n')
    } else {
      process.stdout.write('校验未通过 ' + summary + ',错误 ' + result.errorCount + ' 条,警告 ' + result.warningCount + ' 条\n')
    }
  }

  return result.ok ? 0 : 1
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write('校验失败:' + (error && error.message ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
