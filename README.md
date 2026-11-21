# awesome-dsc-plugin-set-template

dsc 生态的插件合集模板。照抄本仓库,可以快速得到一个符合分发规范 v2 的插件合集:目录骨架、JSON Schema、基于 OpenSSL PKI 的签名工具与自洽性校验脚本都在这里。

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
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── schemas/
│   ├── README.md                           Schema 索引与脚本校验对照
│   ├── manifest.schema.json                三层哈希清单 manifest.json
│   ├── collection-meta.schema.json         合集根 meta.json
│   ├── plugins.schema.json                 合集根插件目录索引 plugins.json
│   ├── tags.schema.json                    合集根 tags.json
│   ├── author-manifest.schema.json         plugins/author_manifest.json
│   ├── plugin-manifest.schema.json         plugins/<作者>/plugin_manifest.json
│   ├── versions.schema.json                plugins/<作者>/<插件>/versions.json
│   └── runtime/meta.json                   插件运行时元数据
├── scripts/
│   ├── pki.mjs                             OpenSSL PKI 封装
│   ├── build-collection.mjs                签名、校验并生成分发内容
│   ├── verify-collection.mjs               自洽性校验
│   ├── import-plugins.mjs                  按清单收录插件
│   └── lib/collection-verify.mjs           两个入口共用的校验逻辑
└── template/                               合集骨架,复制即用
    ├── certs/
    │   └── template/
    │       └── _REPLACE_THIS_FILE_AS_YOUR_EEC_
    │                                       占位文件,须换成 certs/<合集 id>/<合集 id>-eec.crt
    ├── meta.json
    ├── plugins.json
    ├── tags.json
    ├── manifest.json                       L1 清单占位,由 pnpm build 重新生成
    └── plugins/
        ├── author_manifest.json
        └── README.md                       三层目录与必需文件
```

## 用本模板创建一个合集

1. 新建仓库,把 `template/` 下的全部内容复制到仓库根目录。
2. 从本模板仓库根目录一并复制 `scripts/`、`package.json`、`schemas/` 与 `.github/` 到仓库根目录。`template/` 只装合集数据骨架,故意不含这四部分:缺 `package.json` 与 `scripts/` 就跑不了 `pnpm verify` 与 `pnpm build`,缺 `schemas/` 就丢了书面契约,缺 `.github/` 就没有插件来源清单与构建部署工作流。复制后按需修改占位值:`package.json` 的 `name` 与 `repository`、`.github/workflows/build-and-deploy.yml` 的部署配置,以及第 4 步的证书文件名。
3. 在本地生成 EEC 私钥与证书签名请求(CSR):

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out eec_secret.pem
openssl req -new -key eec_secret.pem -out eec.csr -subj '/O=omds-chat/CN=<合集名>'
```

4. 把 `eec.csr` 交给根 CA(`DeepSeek-Chat-Enhanced` 仓库)签发,拿回证书后写到 `certs/<合集 id>/<合集 id>-eec.crt`。合集 id 依次取 `--collection-name`、分发目录 `build-info.json` 的 `collection` 字段、合集目录名,新建合集通常就是仓库目录名。骨架里的 `certs/template/` 与新的合集 id 不同名,复制后要改名为 `certs/<新合集 id>/`;文件夹里的 `_REPLACE_THIS_FILE_AS_YOUR_EEC_` 是占位文件而不是证书,必须把它换成 `certs/<新合集 id>/<新合集 id>-eec.crt` 并删除占位文件。占位文件只用来占位:签名与验签都拒绝它,详见[占位文件与测试流程](#占位文件与测试流程)。
5. 把 `eec_secret.pem` 放进 CI secret `EEC_SECRET_KEY`;把根证书放进 `secrets.ROOT_CA_PEM`,或把 online-data 分支的根证书地址放进 `vars.ROOT_CA_URL`。私钥不得入库。
6. 编辑 `meta.json`:默认关闭下载计数。若要启用,把 `DOWNLOAD_COUNT_ENABLE` 置为 `true`,并同时给出 `DOWNLOAD_COUNT_API` 与 `API_NEED_IP`。
7. 在 `plugins/` 下建立作者目录与插件目录,命名规则与必需文件见 `template/plugins/README.md`;在插件目录索引 `plugins.json` 登记插件,在 `tags.json` 声明预设标签,在 `plugins/author_manifest.json` 登记作者。
8. 在 `.github/plugins-sources.json` 中登记插件来源,运行 `pnpm import` 收录插件,再运行 `pnpm verify` 确认自洽,最后运行 `pnpm build` 生成 `dist/`。

## 占位文件与测试流程

### 占位文件

`template/certs/template/_REPLACE_THIS_FILE_AS_YOUR_EEC_` 是纯文本文件,不是证书:它只占住终端签名证书的位置,提醒这个位置要换成 `certs/<合集 id>/<合集 id>-eec.crt`。脚本对它的处理是固定的:

| 入口 | 行为 |
|:---:|:---:|
| `resolveEecCertPath(dir)` | 按上一节的顺序解析,命中占位文件时 `layout` 为 `placeholder`、`isPlaceholder` 为 `true`,调用方可直接区分 |
| `build-collection.mjs` | 带 `--sign` 时拒绝签名,报 `EEC_PLACEHOLDER` 并给出应替换成的路径,不产出任何签名 |
| `verify-collection.mjs` | 报 `EEC_PLACEHOLDER`:骨架模式下是警告,否则是错误。占位文件不参与证书链、有效期与 `keyUsage` 检查,CMS 相关校验退化为「缺少根证书或终端签名证书」的警告,不会崩溃 |
| `pki.mjs` 的 `signFileCms`、`signManifest`、`verifyFileCms` | 直接拒绝:签名抛 `PkiError`,验签返回 `{ ok: false, reason }`,文案写明占位文件不能用于签名或验签 |

真实证书就位后必须删除占位文件:`pnpm build` 把整个 `certs/` 复制进 `dist/`,残留的占位文件会一起被分发。

### 在临时测试仓库里试跑

验证骨架、脚本改动或新的合集 id 时,不要直接改本仓库:在仓库内建一个临时测试仓库,所有操作都在里面做,结束后删掉。`temp/` 已被 `.gitignore` 忽略,原仓库不会因测试产生任何改动。

| 步骤 | 操作 | 说明 |
|:---:|:---:|:---:|
| 1 | 把仓库复制到 `temp/test-eec/` | `mkdir -p temp/test-eec && cp -r template/. temp/test-eec/ && cp -r scripts schemas .github package.json pnpm-lock.yaml pnpm-workspace.yaml .gitattributes temp/test-eec/`。临时测试仓库是「复制即用」的合集布局:骨架内容在根目录,`scripts/` 与 `schemas/` 同在根目录,不必重新安装依赖 |
| 2 | 从组织离线密钥库取测试用终端签名证书,替换占位文件 | 先把 `certs/template/` 改名为 `certs/<临时合集 id>/`(临时合集 id 默认是目录名 `test-eec`),再把证书写成 `certs/<临时合集 id>/<临时合集 id>-eec.crt`,并删除同目录的占位文件。根证书也从组织离线密钥库取 |
| 3 | 修改临时仓库里的合集 id 与相关代码 | 需要别的 id 时改文件夹名,或校验时加 `--collection-name`;按需改 `meta.json`、`plugins.json`、`tags.json`、`package.json` 与 `.github/workflows/build-and-deploy.yml`。只改 `temp/` 里的副本 |
| 4 | 在临时仓库里跑校验 | `cd temp/test-eec && node scripts/verify-collection.mjs --dir . --root-ca <根证书路径>`。真实证书就位后不应再出现 `EEC_PLACEHOLDER` 与 `EEC_PLACEHOLDER_LEFT` |
| 5 | 清理 | `rm -rf temp/test-eec`。测试证书与根证书只留在临时目录,不入库、不提交 |

临时测试仓库里的一切都是临时的:测试证书、根证书与改过的合集 id 不得回流到原仓库,原仓库的 `certs/` 里只留占位文件。

## 签名与证书链

### 三个角色

| 角色 | 承担者 | 持有物 | 职责 |
|:---:|:---:|:---:|:---:|
| 根证书机构(CA) | `DeepSeek-Chat-Enhanced` 仓库 | 根私钥(离线,不入库)、根证书 | 签发终端签名证书(EEC),维护吊销列表 |
| 终端签名方(EEC) | 插件合集仓库,例如 `awesome-dsc-plugin` | EEC 私钥(CI secret)、`certs/<合集 id>/<合集 id>-eec.crt` | 用 CMS 分离签名给插件文件签名 |
| 独立签名方 | 插件作者,含 omds-chat 自身 | 作者密钥对 | 用裸公钥分离签名追加一份作者签名 |

### 证书位置

合集根目录的 `certs/` 按来源分文件夹,文件夹名与文件名都取签名材料本身的命名;终端签名证书是合集自己的来源,因此落在与合集 id 同名的文件夹里。解析顺序固定,先新后旧:

| 顺序 | 路径 | 说明 |
|:---:|:---:|:---:|
| 1 | `certs/<合集 id>/<合集 id>-eec.crt` | 现行布局,真实证书一律放这里 |
| 2 | `certs/<合集 id>/_REPLACE_THIS_FILE_AS_YOUR_EEC_` | 骨架占位文件,表示该位置尚未换成证书;解析结果 `layout` 为 `placeholder`、`isPlaceholder` 为 `true`,签名与验签都拒绝它 |
| 3 | `eec.pem` | 旧布局,仅为兼容尚未迁移的旧合集保留,新合集不得使用,回退在后续版本删除 |

同一文件夹里可以一并放该来源的公钥,文件名以 `.pub` 结尾;私钥一律不入库。合集 id 的推导顺序:`--collection-name` 显式指定 > 目录内 `build-info.json` 的 `collection` 字段(分发目录 `dist/` 靠它回读)> 合集目录名。模板仓库自身走目录名,因此占位文件是 `template/certs/template/_REPLACE_THIS_FILE_AS_YOUR_EEC_`。命中旧布局时 `pnpm verify` 与 `pnpm build` 都报 `EEC_LEGACY_LAYOUT` 警告并给出应改成的路径;命中占位文件时报 `EEC_PLACEHOLDER`,提示应替换成哪个文件。真实证书就位而占位文件仍在时,校验报 `EEC_PLACEHOLDER_LEFT` 提醒删除。`pnpm build` 把整个 `certs/` 目录复制进 `dist/`,根目录仍有 `eec.pem` 时一并复制,旧验签方因此仍能取到证书。

### 算法与格式

| 项 | 约定 |
|:---:|:---:|
| 根 CA 密钥 | ECDSA P-256,OpenSSL 原生 PEM;自签名证书 `keyUsage=critical,keyCertSign,cRLSign`,`basicConstraints=critical,CA:TRUE,pathlen:0`,有效期 3650 天。浏览器 WebCrypto 对 P-256 支持最广,证书链校验要在浏览器里做,Ed25519 在目标浏览器下限不可用 |
| EEC 密钥 | ECDSA P-256,OpenSSL 原生 PEM。OpenSSL 的 CMS 实现对 Ed25519 报 `provider signature failure`,实测不可用 |
| EEC 证书 | 由根 CA 签发,`keyUsage=critical,digitalSignature`,`basicConstraints=critical,CA:FALSE`,有效期 365 天 |
| 合集签名 | CMS 分离签名,`openssl cms -sign -binary -md sha512 -outform DER -nocerts -noattr`,产物为 `<文件>.sig`。签名与验签都带 `-binary`,按原始字节处理,不经换行规范化;产物固定为 DER,验签带 `-inform DER`。DER 是跨仓库统一格式:默认的 S/MIME `multipart/signed` 包装浏览器无法解析,而插件市场要在浏览器里验签 |
| 作者签名 | 裸公钥分离签名,`openssl pkeyutl -sign -rawin`(Ed25519),产物为 `<文件>.author.sig` |

### 命令

根 CA(离线,只在组织签名环境执行):

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out root_secret.pem
openssl req -x509 -new -key root_secret.pem -days 3650 -out root_ca.crt \
  -subj '/O=omds-chat/CN=omds-chat Root CA' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0'
```

根 CA 签发 EEC。注意 `openssl x509 -req` 不接受 `-addext`,扩展必须经 `-extfile` 传入:

```bash
openssl x509 -req -in eec.csr -CA root_ca.crt -CAkey root_secret.pem -CAcreateserial \
  -out certs/<合集 id>/<合集 id>-eec.crt -days 365 \
  -extfile <(printf 'keyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n')
```

合集签名与验签。三层清单与 `plugin.js` 用同一条命令,只是文件名不同:

```bash
openssl cms -sign -binary -md sha512 -outform DER -in manifest.json -out manifest.json.sig -signer certs/<合集 id>/<合集 id>-eec.crt -inkey eec_secret.pem -nocerts -noattr
openssl cms -verify -binary -md sha512 -inform DER -in manifest.json.sig -content manifest.json -CAfile root_ca.crt -certfile certs/<合集 id>/<合集 id>-eec.crt
```

`-md sha512` 固定摘要算法,不依赖 OpenSSL 的默认值。`-outform DER` 不可省略。默认输出是 S/MIME `multipart/signed` 包装,浏览器无法解析,而插件市场要在浏览器里验签,所以 DER 是跨仓库统一格式:签名方固定 `-outform DER`,验签方固定 `-inform DER`,任何一方改用默认格式都会验签失败。产物可用 `openssl asn1parse -inform DER -in manifest.json.sig` 确认为 DER。

作者签名与验签:

```bash
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in plugin.js -out plugin.js.author.sig
openssl pkeyutl -verify -pubin -inkey author_pub.pem -rawin -in plugin.js -sigfile plugin.js.author.sig
```

启用吊销检查时,把根证书与 CRL 拼进同一个 `-CAfile` 再追加 `-crl_check`:`cat root_ca.crt crl.pem > ca_with_crl.pem`,验签时用 `-CAfile ca_with_crl.pem -crl_check`。OpenSSL 3.5 的 `cms` 子命令没有 `-CRLfile` 选项,CRL 只能随 `-CAfile` 一起传入。

### 分发结构

```text
<collection>/
├── certs/
│   └── <合集 id>/
│       └── <合集 id>-eec.crt    # 终端签名证书,随 Pages 分发,不进任何清单
├── meta.json                  # L1
├── plugins.json               # L1
├── tags.json                  # L1
├── manifest.json              # L1 清单
├── manifest.json.sig          # L1 清单签名
└── plugins/
    ├── author_manifest.json   # L1
    └── <作者>/
        ├── author_pub.pem         # L2,作者公钥,OpenSSL PEM,Ed25519
        ├── plugin_manifest.json   # L2
        ├── manifest.json          # L2 清单
        ├── manifest.json.sig      # L2 清单签名
        └── <插件>/
            ├── versions.json      # L3
            ├── manifest.json      # L3 清单
            ├── manifest.json.sig  # L3 清单签名
            └── <x.y.z>/
                ├── meta.json          # L3
                ├── plugin.js
                ├── plugin.js.sig        # 合集 CMS 签名,覆盖产物本体
                └── plugin.js.author.sig # 作者裸公钥签名,可选
```

分发结构是三层哈希清单,每层一份 `manifest.json` 与一份 `manifest.json.sig`:

| 层 | 位置 | 覆盖的文件(相对该层目录) |
|:---:|:---:|:---:|
| L1 | 合集根 | `meta.json`、`plugins.json`、`plugins/author_manifest.json` 必需,`tags.json` 可选 |
| L2 | `plugins/<作者>/` | `author_pub.pem`、`plugin_manifest.json` |
| L3 | `plugins/<作者>/<插件>/` | `versions.json`、`<版本>/meta.json` |

清单格式,JSON Schema 见 `schemas/manifest.schema.json`:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "files": [
    { "path": "plugins.json", "sha512": "<128 位小写十六进制>" }
  ]
}
```

- `path` 相对清单所在目录,使用正斜杠,不得出现 `..` 或绝对路径,也不得指向清单自身。
- 哈希算法 SHA-512,十六进制小写。
- `revision` 是每层独立的正整数:该层文件集合或内容变化时加一,不变时沿用旧值,没有旧清单时从 1 开始。
- L3 不覆盖 `plugin.js` 与 `plugin.js.sig`:产物本体由每个版本的 `plugin.js.sig` 独立签名,清单只描述元数据。
- `tags.json` 可选:存在就必须被 L1 清单覆盖,不存在则不报错、也不进清单。
- 版本目录的合集签名只有 `plugin.js.sig`,`plugin.js.author.sig` 可选保留。`meta.json` 不单独签名,也不接受作者签名:它由 L3 清单覆盖并由合集 EEC 绑定,作者公钥本身由 L2 覆盖。
- `meta.json`、`plugins.json`、`tags.json`、`plugins/author_manifest.json`、`plugins/<作者>/plugin_manifest.json`、`plugins/<作者>/<插件>/versions.json` 与三层 `manifest.json` 各有 JSON Schema,全部收在 `schemas/`;索引与「哪条脚本规则对应哪个约束」的对照表见 [`schemas/README.md`](schemas/README.md)。

三层之间不做收束:L1 不引用 L2,L2 不引用 L3,任何一层都可以单独发布、单独校验、单独重签。取舍是放弃「一次校验拿到全树摘要」,换取按插件增量更新:改一个插件只需 L3 的 `revision` 加一,L2 与 L1 的 `revision` 不变,客户端也只重新拉取这一层的清单与签名。若把三层收束成一份根清单,任何插件发版都会改动根清单,所有客户端都得重拉整份摘要。

合集的可信性由「根 CA 签发的 EEC」证书链证明,不另发信任签名;根证书不进 `dist/`,由 online-data 分支分发,网页用内嵌的根证书指纹核对。

## 签名与校验

### 签什么

| 签名 | 覆盖对象 | 产物 |
|:---:|:---:|:---:|
| 合集 CMS 签名 | L1、L2、L3 各一份清单 | `manifest.json.sig`,每层一份 |
| 合集 CMS 签名 | 每个版本的 `plugin.js` | `plugin.js.sig` |
| 作者裸公钥签名 | `plugin.js`,可选 | `plugin.js.author.sig` |

签名命令固定为 `openssl cms -sign -binary -md sha512 -outform DER -nocerts -noattr`,产物写到 `<文件>.sig`。`meta.json` 不单独签名,由 L3 清单的 SHA-512 覆盖。

### 校验规则

`pnpm verify` 逐项检查,任一错误都以非零退出码结束并一次性列出全部问题;清单相关的错误带层号,所有错误都带文件路径。

| 编号 | 规则 |
|:---:|:---:|
| 1 | 终端签名证书存在:先找 `certs/<合集 id>/<合集 id>-eec.crt`,再认骨架占位文件 `certs/<合集 id>/_REPLACE_THIS_FILE_AS_YOUR_EEC_`,命中占位文件时只报 `EEC_PLACEHOLDER` 提示、不做证书解析,最后才回退旧的根目录 `eec.pem` 并报 `EEC_LEGACY_LAYOUT` 提示;真实证书须由给定根证书签发(`--root-ca` 或 `ROOT_CA_PATH`),未过期,`keyUsage` 含 `digitalSignature`,`basicConstraints` 非 CA |
| 2 | 插件目录索引 `plugins.json` 中的每个插件都在 `plugins/<author>/plugin_manifest.json` 中出现,且插件目录存在 |
| 3 | 每个插件目录有 `versions.json`,`latest` 必须在 `versions` 列表内 |
| 4 | 每个版本目录有 `meta.json`、`plugin.js`、`plugin.js.sig`,并用 `openssl cms -verify -binary -md sha512 -inform DER -CAfile <根证书> -certfile certs/<合集 id>/<合集 id>-eec.crt` 验签,失败即报错 |
| 5 | 若版本目录存在 `plugin.js.author.sig`,则 `plugins/<author>/author_pub.pem` 必须存在,并用 `openssl pkeyutl -verify` 验证,失败即报错;其它 `*.author.sig` 不参与校验 |
| 6 | `tags.json` 存在时,`plugins.json` 的 `tag` 必须取自其中 |
| 7 | 三层清单存在且结构合法:`schemaVersion` 为 1,`revision` 为正整数,`files` 为非空数组,条目只含 `path` 与 `sha512` |
| 8 | 清单条目的 `path` 合法:正斜杠、相对路径、不含 `..`、不指向清单自身、不重复 |
| 9 | 覆盖范围与该层应有的文件严格相等:该有的都在清单里,清单里没有多余项,L3 不得出现 `plugin.js` 与 `plugin.js.sig` |
| 10 | 清单记录的每个 SHA-512 与文件实际内容一致,不一致时报出层号与具体文件 |
| 11 | 每层 `manifest.json.sig` 用根证书与终端签名证书验签,失败即报错 |
| 12 | 作者目录名、`plugins.json` 的 `author` 与 `plugins/author_manifest.json` 的 `username` 都必须是合法的 GitHub 用户名,正则 `^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$`,不区分大小写,长度上限 39,不得以连字符开头或结尾。目录名不符报 `AUTHOR_DIR_NAME_INVALID` 并指出 `plugins/<目录>`;`author` 与 `username` 不符分别报 `PLUGINS_INDEX_INVALID`、`AUTHOR_MANIFEST_INVALID` |
| 13 | 插件名必须带 `dsc-` 前缀。`plugins.json` 的 `plugin_name` 与 `plugins/<作者>/plugin_manifest.json` 的每一项都按 `PLUGIN_NAME_PATTERN` 校验,即 `^(?:dsc-[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*/dsc-[a-z0-9][a-z0-9._-]*)$`,缺前缀报 `PLUGINS_INDEX_INVALID` 或 `PLUGIN_MANIFEST_INVALID` |

`pnpm verify` 默认带 `--allow-placeholder-eec`,用于骨架自身:终端签名证书仍是占位文件、根证书缺失、终端签名证书未由根 CA 签发、三层清单或清单签名尚未生成时降级为警告。占位文件只在骨架模式下降级,它始终不会被当成证书解析;真实合集的 CI 不带这个开关,占位文件没换掉就是错误。`--allow-missing-manifest` 只放开清单与清单签名缺失,结构与哈希检查照常执行。

本仓库的脚本是发布前的强校验:除上面显式放开的开关,任一错误都会阻断发布。

## 签名工具接口

`scripts/pki.mjs` 只调用 openssl,不实现任何密码学。全部函数同步返回,失败抛 `PkiError`,`verify*` 系列不抛错而是返回 `{ ok, reason }`,便于一次性汇总问题。

| 函数 | 说明 |
|:---:|:---:|
| `genRootCa(dir)` | 生成 ECDSA P-256 根私钥与自签名根证书,返回 `{ keyPath, certPath }` |
| `genEecKey(dir)` | 生成 ECDSA P-256 的 EEC 私钥 |
| `genCsr(dir, commonName, org)` | 用已有 EEC 私钥生成 CSR |
| `issueEec(csr, rootCrt, rootKey, out)` | 用根 CA 签发 EEC 证书,扩展经临时 `--extfile` 传入 |
| `signFileCms(file, eecCrt, eecKey)` | 生成 CMS 分离签名,输出 `<文件>.sig` |
| `verifyFileCms(file, sig, rootCrt, eecCrt)` | 校验 CMS 分离签名,信任锚是根证书 |
| `signManifest(manifest, eecCrt, eecKey)` | 为清单签名,输出 `<清单>.sig`,参数与 `signFileCms` 一致 |
| `verifyManifest(manifest, sig, rootCrt, eecCrt)` | 校验清单签名 |
| `genAuthorKey(dir)` | 生成作者 Ed25519 密钥对,返回 `{ keyPath, pubPath }` |
| `signFileAuthor(file, authorKey)` | 生成作者裸公钥分离签名,输出 `<文件>.author.sig` |
| `verifyFileAuthor(file, sig, authorPub)` | 校验作者签名 |
| `describeCertificate(certPath)` | 读取主题、签发者、有效期、`keyUsage`、`basicConstraints` |
| `verifyChain(certPath, rootCrt)` | 等价于 `openssl verify -CAfile <根证书> <证书>` |
| `certMatchesKey(certPath, keyPath)` | 判断证书与私钥是否配对,签名前用它拦住用错私钥 |
| `resolveEecCertPath(dir)` | 解析终端签名证书位置,按现行布局、占位文件、旧布局的顺序命中,返回 `layout`(`certs`、`placeholder`、`legacy`)与 `isPlaceholder` |

## 校验与部署流程

- 本地:`pnpm install` 之后运行 `pnpm verify`。`pnpm build` 先补齐三层清单,再校验,最后把分发内容写入 `dist/`;带 `--sign` 时用 `EEC_SECRET_KEY` 为三层清单与每个版本的 `plugin.js` 生成签名。
- 三层 `manifest.json` 与 `manifest.json.sig` 必须持久化,但落点不是主分支。revision 从该层上一份清单读出,读不回来就只能从 1 重新开始,跨 CI 的 revision 沿用随之失效;所以清单提交进与主分支无公共祖先的归档分支,主分支的提交里不留同一层的清单副本。流水线按「读回、生成、写回」三步走:先从归档分支读回该层上一版清单,再生成新的清单与签名,最后把这两份新产物写回归档分支。归档分支名为 `online-data`,写回失败时的处理方式待定;取舍、边界与三步顺序见 [`docs/design/collection-contract.md`](docs/design/collection-contract.md) 第 6 节。
- 自动化:推送到 main 或手动触发 `build-and-deploy`,依次安装依赖、按清单收录插件、解析根证书、用 `openssl verify` 校验终端签名证书的证书链、用 `EEC_SECRET_KEY` 签名并构建 `dist/`、对 `dist/` 再跑一次完整校验,最后发布到 Pages。
- 根证书来源二选一:`secrets.ROOT_CA_PEM`(PEM 文本)优先,否则用 `vars.ROOT_CA_URL` 从 online-data 分支拉取。
- 签名私钥只从 secrets 读取,仓库内不存放任何私钥。
- 分发必须开启跨域访问,至少放行 `omds-chat.github.io`。

## 安全提示

- 根私钥离线保管,只在签发 EEC 或生成 CRL 时使用;EEC 私钥与作者私钥只放 CI secrets 与本地环境变量。`.gitignore` 已排除 `.env`。
- 终端签名证书被替换或私钥泄露时,应立刻通知根 CA 吊销并重新签发;`crl.pem` 生成后,验签方追加 `--crl_check` 即可生效。
- 签名针对文件字节。CMS 签名与作者签名都是逐字节语义(分别用 `-binary` 与 `-rawin`),换行、缩进或空白的任何改动都会让校验失败;把 LF 改成 CRLF 同样会失败,仓库统一使用 LF。
- `build-collection.mjs --sign` 会先确认 `EEC_SECRET_KEY` 与仓库内终端签名证书配对,不配对直接失败,避免产出一批无法验签的签名;证书仍是占位文件时同样直接失败。
- 占位文件与测试用证书都不得入库、不得进入分发:发布前确认 `certs/<合集 id>/` 里只有真实终端签名证书,没有残留的 `_REPLACE_THIS_FILE_AS_YOUR_EEC_`。
- 校验失败时不要绕过。错误信息会指出具体文件与失败原因。

## 许可

Apache License 2.0,见 [LICENSE](LICENSE)。
