# dsc-plugin-set-template

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

## 文档导航

全部文档的索引、分层与冲突裁决顺序见 [docs/README.md](docs/README.md)。

| 想做什么 | 去哪里 |
|:---:|:---:|
| 从零把一个合集做到可分发:创建步骤、签名与证书链、校验规则、部署流程、安全提示 | [docs/user/collection-guide.md](docs/user/collection-guide.md)(英文版 [collection-guide.en-US.md](docs/user/collection-guide.en-US.md)) |
| 弄清某条设计为什么这样定、边界在哪里 | [docs/design/collection-contract.md](docs/design/collection-contract.md) |
| 查插件树布局、每层必需文件与清单空基线 | [template/plugins/README.md](template/plugins/README.md)(插件树布局的权威出处) |
| 查 JSON 字段与脚本校验的对应关系 | [schemas/README.md](schemas/README.md) |

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
├── docs/
│   ├── README.md                           文档索引:每份文档的职责、分层与冲突裁决
│   ├── design/
│   │   └── collection-contract.md          设计文档:骨架、合集 id、证书解析、构建与校验分工、清单持久化
│   └── user/
│       ├── collection-guide.md             合集操作手册(中文):从零建到一个可分发的合集
│       └── collection-guide.en-US.md       操作手册英文版,与中文版逐节对应
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
    ├── manifest.json                       L1 清单的空基线(首次构建前),由 pnpm build 重新生成
    └── plugins/
        ├── author_manifest.json
        └── README.md                       插件树布局权威出处:三层目录、必需文件与清单空基线
```

## 最小可用步骤

新建合集的完整步骤、签名材料准备与占位文件替换见[操作手册](docs/user/collection-guide.md)第 1 节,这里只列主干:

1. 复制 `template/` 到新仓库根目录,再一并复制 `scripts/`、`package.json`、`schemas/` 与 `.github/`。
2. 生成 EEC 私钥与 CSR,交根 CA(`DeepSeek-Chat-Enhanced` 仓库)签发,证书写到 `certs/<合集 id>/<合集 id>-eec.crt` 并删除占位文件。
3. 私钥放 CI secret `EEC_SECRET_KEY`,根证书放 `secrets.DS_CHAT_ROOT_CA` 或其地址放 `vars.ROOT_CA_URL`。
4. 建作者、插件与版本目录并登记索引,在 `.github/plugins-sources.json` 登记来源,依次跑 `pnpm import`、`pnpm verify`、`pnpm build`。
5. 为三层清单建归档并行分支(现行名 `ci-memory`),再推送触发 `build-and-deploy` 发布。

## 许可

Apache License 2.0,见 [LICENSE](LICENSE)。
