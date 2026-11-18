# awesome-dsc-plugin-set-template

dsc 插件合集模板。照抄本仓库,可以快速得到一个符合分发规范 v2 的插件合集:目录骨架、JSON Schema、基于 OpenSSL PKI 的签名工具与自洽性校验脚本都在这里。

本仓库本身不是插件合集,它只提供骨架与规范载体,不收录任何插件。

[English](README.en-US.md)

## 你能拿到什么

| 内容 | 位置 | 用途 |
|:---:|:---:|:---:|
| 合集骨架 | `template/` | 复制到新仓库根目录即可开工 |
| JSON Schema | `schemas/` | 校验合集元数据、清单与版本结构 |
| 签名工具 | `scripts/pki.mjs` | 把 openssl 的根 CA、EEC、CMS 签名与作者签名包装成函数 |
| 校验与构建 | `scripts/build-collection.mjs`,`scripts/verify-collection.mjs` | 一条命令检查合集自洽性并生成分发内容 |
| 插件收录 | `scripts/import-plugins.mjs` | 按来源清单构建插件,复制作者签名与作者公钥 |
| 构建部署流程 | `.github/workflows/build-and-deploy.yml` | 推送到 main 后自动校验并发布 |

## 目录结构

```text
.
├── .github/
│   ├── plugins-sources.json                插件来源清单,import-plugins.mjs 读取
│   └── workflows/build-and-deploy.yml      构建与部署流程
├── .gitattributes                          统一 LF 换行
├── .gitignore
├── LICENSE
├── README.md
├── README.en-US.md
├── package.json
├── pnpm-workspace.yaml
├── schemas/
│   ├── runtime/meta.json                   插件运行时元数据
│   └── collection/                         合集元数据、清单、版本
├── scripts/
│   ├── pki.mjs                             OpenSSL PKI 封装
│   ├── build-collection.mjs                签名、校验并生成分发内容
│   ├── verify-collection.mjs               自洽性校验
│   ├── import-plugins.mjs                  按清单收录插件
│   └── lib/collection-verify.mjs           两个入口共用的校验逻辑
└── template/                               合集骨架,复制即用
    ├── eec.pem                             占位证书,必须换成根 CA 签发的证书
    ├── meta.json
    ├── datalog.json
    ├── tags.json
    └── plugins/
        ├── author_manifest.json
        └── README.md                       三层目录与必需文件
```

## 用本模板创建一个合集

1. 新建仓库,把 `template/` 下的全部内容复制到仓库根目录。
2. 在本地生成 EEC 私钥与证书签名请求(CSR):

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out eec_secret.pem
openssl req -new -key eec_secret.pem -out eec.csr -subj '/O=omdsc-dev/CN=<合集名>'
```

3. 把 `eec.csr` 交给根 CA(`DeepSeek-Chat-Enhanced` 仓库)签发,拿回证书后覆盖根目录的 `eec.pem`。骨架里的 `eec.pem` 是占位证书,不能用于任何真实签名。
4. 把 `eec_secret.pem` 放进 CI secret `EEC_SECRET_KEY`;把根证书放进 `secrets.ROOT_CA_PEM`,或把 online-data 分支的根证书地址放进 `vars.ROOT_CA_URL`。私钥不得入库。
5. 编辑 `meta.json`:默认关闭下载计数。若要启用,把 `DOWNLOAD_COUNT_ENABLE` 置为 `true`,并同时给出 `DOWNLOAD_COUNT_API` 与 `API_NEED_IP`。
6. 在 `plugins/` 下建立作者目录与插件目录,命名规则与必需文件见 `template/plugins/README.md`;在 `datalog.json` 登记插件,在 `tags.json` 声明预设标签,在 `plugins/author_manifest.json` 登记作者。
7. 在 `.github/plugins-sources.json` 中登记插件来源,运行 `pnpm import` 收录插件,再运行 `pnpm verify` 确认自洽,最后运行 `pnpm build` 生成 `dist/`。

## 签名与证书链

### 三个角色

| 角色 | 承担者 | 持有物 | 职责 |
|:---:|:---:|:---:|:---:|
| 根证书机构(CA) | `DeepSeek-Chat-Enhanced` 仓库 | 根私钥(离线,不入库)、根证书 | 签发终端签名证书(EEC),维护吊销列表 |
| 终端签名方(EEC) | 插件合集仓库,例如 `awesome-dsc-plugin` | EEC 私钥(CI secret)、`eec.pem` | 用 CMS 分离签名给插件文件签名 |
| 独立签名方 | 插件作者,含 omdsc-dev 自身 | 作者密钥对 | 用裸公钥分离签名追加一份作者签名 |

### 算法与格式

| 项 | 约定 |
|:---:|:---:|
| 根 CA 密钥 | Ed25519,OpenSSL 原生 PEM;自签名证书 `keyUsage=critical,keyCertSign,cRLSign`,`basicConstraints=critical,CA:TRUE,pathlen:0`,有效期 3650 天 |
| EEC 密钥 | ECDSA P-256,OpenSSL 原生 PEM。OpenSSL 的 CMS 实现对 Ed25519 报 `provider signature failure`,实测不可用 |
| EEC 证书 | 由根 CA 签发,`keyUsage=critical,digitalSignature`,`basicConstraints=critical,CA:FALSE`,有效期 365 天 |
| 合集签名 | CMS 分离签名,`openssl cms -sign -binary -nocerts -noattr`,产物为 `<文件>.sig`。签名与验签都带 `-binary`,按原始字节处理,不经换行规范化 |
| 作者签名 | 裸公钥分离签名,`openssl pkeyutl -sign -rawin`(Ed25519),产物为 `<文件>.author.sig` |

### 命令

根 CA(离线,只在组织签名环境执行):

```bash
openssl genpkey -algorithm ed25519 -out root_secret.pem
openssl req -x509 -new -key root_secret.pem -days 3650 -out root_ca.crt \
  -subj '/O=omdsc-dev/CN=omdsc-dev Root CA' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0'
```

根 CA 签发 EEC。注意 `openssl x509 -req` 不接受 `-addext`,扩展必须经 `-extfile` 传入:

```bash
openssl x509 -req -in eec.csr -CA root_ca.crt -CAkey root_secret.pem -CAcreateserial \
  -out eec.pem -days 365 \
  -extfile <(printf 'keyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n')
```

合集签名与验签:

```bash
openssl cms -sign -binary -in meta.json -out meta.json.sig -signer eec.pem -inkey eec_secret.pem -nocerts -noattr
openssl cms -verify -binary -in meta.json.sig -content meta.json -CAfile root_ca.crt -certfile eec.pem
```

作者签名与验签:

```bash
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in plugin.js -out plugin.js.author.sig
openssl pkeyutl -verify -pubin -inkey author_pub.pem -rawin -in plugin.js -sigfile plugin.js.author.sig
```

启用吊销检查时追加 `-CRLfile crl.pem -crl_check`。

### 分发结构

```text
<collection>/
├── eec.pem                # 终端签名证书,随 Pages 分发
├── meta.json
├── datalog.json
├── tags.json
└── plugins/
    ├── author_manifest.json
    └── <作者>/
        ├── author_pub.pem        # 作者公钥,OpenSSL PEM,Ed25519
        ├── plugin_manifest.json
        └── <插件>/
            ├── versions.json
            └── <x.y.z>/
                ├── meta.json
                ├── meta.json.sig        # 合集 CMS 签名
                ├── plugin.js
                ├── plugin.js.sig        # 合集 CMS 签名
                └── plugin.js.author.sig # 作者裸公钥签名,可选
```

旧的 `plugin_secret.pub` 与 `plugin_set_sign.json` 已删除。合集的可信性由「根 CA 签发的 EEC」证明,不再单独签发信任签名;根证书不进 `dist/`,由 online-data 分支分发,网页用内嵌的根证书指纹核对。

## 校验规则

`pnpm verify` 逐项检查,任一错误都以非零退出码结束并一次性列出全部问题,每条都带文件路径。

| 编号 | 规则 |
|:---:|:---:|
| 1 | 根目录 `eec.pem` 存在,由给定根证书签发(`--root-ca` 或 `ROOT_CA_PATH`),未过期,`keyUsage` 含 `digitalSignature`,`basicConstraints` 非 CA |
| 2 | `datalog.json` 中的每个插件都在 `plugins/<author>/plugin_manifest.json` 中出现,且插件目录存在 |
| 3 | 每个插件目录有 `versions.json`,`latest` 必须在 `versions` 列表内 |
| 4 | 每个版本目录有 `meta.json`、`meta.json.sig`、`plugin.js`、`plugin.js.sig`,并用 `openssl cms -verify -binary -CAfile <根证书> -certfile eec.pem` 验签,失败即报错 |
| 5 | 若存在 `<文件>.author.sig`,则 `plugins/<author>/author_pub.pem` 必须存在,并用 `openssl pkeyutl -verify` 验证,失败即报错 |
| 6 | `tags.json` 存在时,`datalog.json` 的 `tag` 必须取自其中 |

`pnpm verify` 默认带 `--allow-placeholder-eec`,用于骨架自身:根证书缺失或 `eec.pem` 未由根 CA 签发时降级为警告。真实合集的 CI 不带这个开关。

校验语义分两档:本仓库的脚本是发布前的强校验,失败即阻断;插件市场一侧的证书链校验、插件签名校验与网页文件签名校验失败只警告,不阻断,也不做兜底。

## 签名工具接口

`scripts/pki.mjs` 只调用 openssl,不实现任何密码学。全部函数同步返回,失败抛 `PkiError`,`verify*` 系列不抛错而是返回 `{ ok, reason }`,便于一次性汇总问题。

| 函数 | 说明 |
|:---:|:---:|
| `genRootCa(dir)` | 生成 Ed25519 根私钥与自签名根证书,返回 `{ keyPath, certPath }` |
| `genEecKey(dir)` | 生成 ECDSA P-256 的 EEC 私钥 |
| `genCsr(dir, commonName, org)` | 用已有 EEC 私钥生成 CSR |
| `issueEec(csr, rootCrt, rootKey, out)` | 用根 CA 签发 EEC 证书,扩展经临时 `--extfile` 传入 |
| `signFileCms(file, eecCrt, eecKey)` | 生成 CMS 分离签名,输出 `<文件>.sig` |
| `verifyFileCms(file, sig, rootCrt, eecCrt)` | 校验 CMS 分离签名,信任锚是根证书 |
| `genAuthorKey(dir)` | 生成作者 Ed25519 密钥对,返回 `{ keyPath, pubPath }` |
| `signFileAuthor(file, authorKey)` | 生成作者裸公钥分离签名,输出 `<文件>.author.sig` |
| `verifyFileAuthor(file, sig, authorPub)` | 校验作者签名 |
| `describeCertificate(certPath)` | 读取主题、签发者、有效期、`keyUsage`、`basicConstraints` |
| `verifyChain(certPath, rootCrt)` | 等价于 `openssl verify -CAfile <根证书> <证书>` |
| `certMatchesKey(certPath, keyPath)` | 判断证书与私钥是否配对,签名前用它拦住用错私钥 |

## 校验与部署流程

- 本地:`pnpm install` 之后运行 `pnpm verify`。`pnpm build` 会在校验通过后把分发内容写入 `dist/`;带 `--sign` 时先签名再校验。
- 自动化:推送到 main 或手动触发 `build-and-deploy`,依次安装依赖、按清单收录插件、解析根证书、用 `openssl verify` 校验 `eec.pem` 的证书链、用 `EEC_SECRET_KEY` 签名并构建 `dist/`、对 `dist/` 再跑一次完整校验,最后发布到 Pages。
- 根证书来源二选一:`secrets.ROOT_CA_PEM`(PEM 文本)优先,否则用 `vars.ROOT_CA_URL` 从 online-data 分支拉取。
- 签名私钥只从 secrets 读取,仓库内不存放任何私钥。
- 分发必须开启跨域访问,至少放行 `omdsc-dev.github.io`。

## 安全提示

- 根私钥离线保管,只在签发 EEC 或生成 CRL 时使用;EEC 私钥与作者私钥只放 CI secrets 与本地环境变量。`.gitignore` 已排除 `.env`。
- `eec.pem` 被替换或私钥泄露时,应立刻通知根 CA 吊销并重新签发;`crl.pem` 生成后,验签方追加 `--crl_check` 即可生效。
- 签名针对文件字节。CMS 签名与作者签名都是逐字节语义(分别用 `-binary` 与 `-rawin`),换行、缩进或空白的任何改动都会让校验失败;把 LF 改成 CRLF 同样会失败,仓库统一使用 LF。
- `build-collection.mjs --sign` 会先确认 `EEC_SECRET_KEY` 与仓库内 `eec.pem` 配对,不配对直接失败,避免产出一批无法验签的签名。
- 校验失败时不要绕过。错误信息会指出具体文件与失败原因。

## 许可

Apache License 2.0,见 [LICENSE](LICENSE)。
