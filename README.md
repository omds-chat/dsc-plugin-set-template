# awesome-dsc-plugin-set-template

dsc 插件合集模板。照抄本仓库,可以快速得到一个符合分发规范 v2 的插件合集：目录骨架、JSON Schema、签名工具与自洽性校验脚本都在这里。

本仓库本身不是插件合集,它只提供骨架与规范载体,不收录任何插件。

[English](README.en-US.md)

## 你能拿到什么

| 内容 | 位置 | 用途 |
|:---:|:---:|:---:|
| 合集骨架 | `template/` | 复制到新仓库根目录即可开工 |
| JSON Schema | `schemas/` | 校验合集元数据、清单、版本与签名结构 |
| 签名工具 | `scripts/sign.mjs` | Ed25519 hash-then-sign 的签名与验签纯函数 |
| 校验与构建 | `scripts/build-collection.mjs`、`scripts/verify-collection.mjs` | 一条命令检查合集自洽性并生成分发内容 |
| 构建部署流程 | `.github/workflows/build-and-deploy.yml` | 推送到 main 后自动校验并发布 |

## 目录结构

```text
.
├── .github/workflows/build-and-deploy.yml   构建与部署流程
├── .gitattributes                          统一 LF 换行
├── .gitignore
├── LICENSE
├── README.md
├── README.en-US.md
├── package.json
├── pnpm-workspace.yaml
├── schemas/                                全部 JSON Schema
│   ├── runtime/meta.json                   插件运行时元数据
│   ├── runtime/plugin_sign.json            插件签名清单
│   ├── sign/plugin_set_sign.json           合集信任签名
│   └── collection/                         合集元数据、清单、版本
├── scripts/
│   ├── sign.mjs                            签名与验签工具
│   ├── build-collection.mjs                校验并生成分发内容
│   ├── verify-collection.mjs               自洽性校验
│   └── lib/collection-verify.mjs           两个脚本共用的校验逻辑
└── template/                               合集骨架,复制即用
    ├── meta.json
    ├── plugin_secret.pub
    ├── plugin_set_sign.json
    ├── datalog.json
    ├── tags.json
    ├── author_manifest.json
    └── plugins/
        └── README.md                       作者目录与插件目录的命名规则
```

## 用本模板创建一个合集

1. 新建仓库,把 `template/` 下的全部内容复制到仓库根目录。
2. 编辑 `meta.json`：默认关闭下载计数。若要启用,把 `DOWNLOAD_COUNT_ENABLE` 置为 `true`,并同时给出 `DOWNLOAD_COUNT_API` 与 `API_NEED_IP`。
3. 生成合集公钥：用合集私钥跑 `node scripts/sign.mjs derive-public-key <私钥路径> > plugin_secret.pub`。仓库内的占位公钥必须被覆盖。
4. 把 `plugin_secret.pub` 交给 dsc 维护方,换取 `plugin_set_sign.json` 里的一条 `{ "value": "...", "signer": "dsc" }`。信任签名只针对该文件的字节,公钥一旦更换就要重新签发。
5. 在 `plugins/` 下建立作者目录与插件目录,命名规则见 `template/plugins/README.md`。
6. 在 `datalog.json` 中登记插件,在 `tags.json` 中声明预设标签,在 `plugins/author_manifest.json` 中登记作者。
7. 运行 `pnpm verify` 确认自洽,再运行 `pnpm build` 生成 `dist/`。

## 信任链如何工作

三层签名,每层只签下一层需要的东西。

| 层 | 签名者 | 私钥 | 被签名对象 | 产物 |
|:---:|:---:|:---:|:---:|:---:|
| dsc | `dsc` | 组织私钥 `WEB_PRIVATE_KEY` | 合集根目录 `plugin_secret.pub` 的字节 | `plugin_set_sign.json` |
| 合集 | 合集名 | 合集私钥 `PLUGIN_PRIVATE_KEY` | 每个版本的 `meta.json` 与 `plugin.js` | 版本目录内的 `plugin_sign.json` |
| 作者 | 作者名 | 作者私钥 `AUTHOR_SIGN_PRIVATE_KEY` | 同上,可选 | 追加进同一个 `plugin_sign.json` |

- 插件市场内置 dsc 公钥。校验顺序是：先验证 `plugin_set_sign.json`,通过后才信任该合集的 `plugin_secret.pub`,再用它验证插件签名。
- 不支持下级派生。合集不能为另一个合集签发信任签名。
- 算法固定为 Ed25519,采用 hash-then-sign：先对文件字节做 SHA-512 摘要,再对摘要字节签名,签名以 base64 编码。
- 作者自签名与合集签名并存于同一个 `plugin_sign.json`,靠 `signer` 字段区分。插件市场对作者自签名只做记录与提示。

## 校验规则

`pnpm verify` 逐项检查,任一错误都以非零退出码结束并列出全部问题。

| 编号 | 规则 |
|:---:|:---:|
| 1 | 根目录 `plugin_secret.pub` 存在,且为合法的 Ed25519 SPKI PEM 公钥 |
| 2 | 根目录 `plugin_set_sign.json` 存在,且至少一条签名能用 dsc 公钥验证通过 |
| 3 | `datalog.json` 中的每个 `plugin_name` 都出现在 `plugins/<author>/plugin_manifest.json` 中,且插件目录存在 |
| 4 | 每个插件目录有 `versions.json`,`latest` 必须在 `versions` 列表内 |
| 5 | 每个版本目录有 `meta.json`、`plugin.js`、`plugin_sign.json`,且签名文件覆盖前两个文件 |
| 6 | 合集签名用合集公钥验证,作者自签名用 `plugins/<author>/plugin_secret.pub` 验证 |
| 7 | `tags.json` 存在时,`datalog.json` 中的 `tag` 必须取自其中 |

## 签名工具接口

`scripts/sign.mjs` 导出下列纯函数,不依赖任何仓库结构,可被其他仓库直接引用。

| 函数 | 说明 |
|:---:|:---:|
| `loadPrivateKey(pem)` | 载入 PKCS#8 PEM 私钥 |
| `loadPublicKey(pem)` | 载入 SPKI PEM 公钥 |
| `derivePublicKey(pem)` | 由私钥推导公钥 PEM |
| `digestSha512(buffer)` | 计算 SHA-512 摘要 |
| `signDigest(buffer, privateKeyPem)` | 对摘要签名,返回 base64 字符串 |
| `signFile(filePath, privateKeyPem, signer)` | 签名单个文件,返回 `{ value, for, signer }` |
| `verifyFile(filePath, signatureBase64, publicKeyPem)` | 校验文件签名,返回布尔值 |
| `buildSignFile(entries)` | 构造 `{ "sign": [...] }` 结构 |
| `readSignFile(path)` | 读取并校验 `plugin_sign.json` 结构 |

## 校验与部署流程

- 本地：`pnpm install` 之后运行 `pnpm verify`。`pnpm build` 会在校验通过后把分发内容写入 `dist/`。
- 自动化：推送到 main 或手动触发 `build-and-deploy`,依次安装依赖、运行 `scripts/verify-collection.mjs`、用 secrets 中的私钥为插件签名并构建 `dist/`,最后发布到 Pages。
- 签名私钥只从 secrets 读取。`WEB_PRIVATE_KEY` 用于推导 dsc 信任公钥,`PLUGIN_PRIVATE_KEY` 用于给插件签名,仓库内不存放任何私钥。
- 分发必须开启跨域访问,至少放行 `omdsc-dev.github.io`。

## 安全提示

- 私钥只放 CI secrets 与本地环境变量,不要提交。`.gitignore` 已排除 `.env`。
- 更换合集私钥会让 dsc 已签发的信任签名全部失效,必须重新申请。`build-collection.mjs --sign` 在私钥推导出的公钥与仓库内 `plugin_secret.pub` 不一致时会直接失败。
- 签名针对文件字节。换行、缩进或空白的任何改动都会让校验失败,仓库统一使用 LF。
- 插件产物建议行压缩,既减小体积,也避免无意义的空白差异。
- 校验失败时不要绕过。错误信息会指出具体文件与签名者。

## 许可

Apache License 2.0,见 [LICENSE](LICENSE)。
