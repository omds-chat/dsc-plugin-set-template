# 合集 JSON 的 Schema 索引

本目录存放插件合集分发的全部 JSON 的 JSON Schema,统一使用 draft 2020-12。Schema 与 `scripts/` 下的校验脚本描述同一套约束:脚本是权威实现,Schema 是书面契约。

## 文件清单

| Schema 文件 | 约束的 JSON | JSON 在合集里的位置 | 生成它的脚本 | 校验它的脚本 |
|:---:|:---:|:---:|:---:|:---:|
| `manifest.schema.json` | `manifest.json` | L1 合集根、L2 `plugins/<作者>/`、L3 `plugins/<作者>/<插件>/` | `scripts/build-collection.mjs` 的 `buildManifests` → `writeLayerManifest` | 校验规则 7、8、9;`scripts/lib/collection-verify.mjs` 的 `verifyLayerManifest` 与 `manifestPathProblem` |
| `collection-meta.schema.json` | `meta.json` | 合集根 | 无脚本生成,`template/meta.json` 提供初值,`build-collection.mjs` 只做拷贝 | 校验规则表未单列;`verifyCollection` 第二节,错误码 `META_FIELD_INVALID` |
| `plugins.schema.json` | `plugins.json` | 合集根,插件目录索引 | `scripts/import-plugins.mjs` 的 `planPluginsIndex` | 校验规则 2、6;`verifyCollection` 第五节,错误码 `PLUGINS_INDEX_INVALID`、`PLUGINS_INDEX_DUPLICATE`、`TAG_NOT_DECLARED` |
| `tags.schema.json` | `tags.json` | 合集根,可选文件 | 无脚本生成,人工维护 | 校验规则 6;`verifyCollection` 第四节,错误码 `TAGS_INVALID`、`TAGS_DUPLICATE` |
| `author-manifest.schema.json` | `author_manifest.json` | `plugins/` | `scripts/import-plugins.mjs` 的 `planAuthorManifest` | 校验规则 12;`verifyCollection` 第六节与第七节(作者目录命名),错误码 `AUTHOR_MANIFEST_INVALID`、`AUTHOR_MANIFEST_DUPLICATE`、`AUTHOR_NOT_REGISTERED` |
| `plugin-manifest.schema.json` | `plugin_manifest.json` | `plugins/<作者>/` | `scripts/import-plugins.mjs` 的 `planPluginManifest` | 校验规则 2;`inspectAuthor`,错误码 `PLUGIN_MANIFEST_INVALID` |
| `versions.schema.json` | `versions.json` | `plugins/<作者>/<插件>/` | `scripts/import-plugins.mjs` 的 `planVersions` | 校验规则 3;`inspectPlugin`,错误码 `VERSIONS_INVALID`、`LATEST_NOT_LISTED`;`readVersionList` 负责读出版本目录清单 |
| `runtime/meta.json` | `meta.json` | `plugins/<作者>/<插件>/<版本>/` | `scripts/import-plugins.mjs` 从插件构建产物 `dist/meta.json` 复制 | 字段级约束由插件运行时校验,本仓库脚本只比对 `name` 与 `version` 是否同插件目录索引 `plugins.json`、目录名一致(`inspectVersionMeta`,错误码 `PLUGIN_META_MISMATCH`) |

"校验规则 N" 指 [合集操作手册](../docs/user/collection-guide.md) 第 4.2 节校验规则表中编号为 N 的那一条。插件名与作者名的正则同时是插件树布局契约的一部分,布局条文的权威出处是 [`template/plugins/README.md`](../template/plugins/README.md),使用同一布局的其他仓库按该文与本目录同步正则。

## Schema 与脚本校验的关系

- 脚本是权威实现。一份 JSON 能否通过 `pnpm verify` 与 `pnpm build`,只由 `scripts/lib/collection-verify.mjs` 决定;Schema 不参与运行时校验,它描述的是同一套约束的书面形式。
- Schema 是书面契约。文档、`template/` 骨架与插件市场按 Schema 理解字段。脚本改了而 Schema 没改,契约就失真;Schema 先行而脚本没跟上,脚本就会放过 Schema 已经禁止的写法。两者必须一致。
- 改一处必须同步另一处。新增字段时,在 `collection-verify.mjs` 的检查分支里加判断,同时在对应 Schema 的 `properties` 与 `required` 里补上;删除或放宽约束时,两边一起改。评审时按本文件上表逐条对照,不凭印象。
- 脚本能查、Schema 表达不了的约束,只由脚本保证,并在对应 Schema 的 `description` 或 `$comment` 里注明:
  - 唯一性的一半:插件目录索引 `plugins.json` 的 `plugin_name`、`author_manifest.json` 的 `username`。JSON Schema 没有按属性去重的关键字,数组级 `uniqueItems` 只在条目完全相同时生效,所以两份 Schema 只拦住「一字不差」的重复项,「同名但 `tag` 或 `profile` 不同」这类重复只能由脚本的 `PLUGINS_INDEX_DUPLICATE`、`AUTHOR_MANIFEST_DUPLICATE` 查。`plugin_manifest.json` 与 `tags.json` 是字符串数组,`uniqueItems` 在那里能完整去重。
  - 顺序:`versions.json` 的 `versions` 按版本号降序。
  - 集合关系:`latest` 必须出现在 `versions` 内;插件目录索引 `plugins.json` 的 `tag` 必须取自 `tags.json`。
  - 文件系统与签名:版本目录是否存在、`plugin.js.sig` 能否验签、三层清单的覆盖范围与 SHA-512。这些不是 JSON 结构问题,不在任何 Schema 的覆盖范围内,只由 `collection-verify.mjs` 与 `scripts/pki.mjs` 处理。
- 反过来,Schema 比脚本严的地方也在文件里写明理由:`versions.schema.json` 的 `uniqueItems`(去重由 `planVersions` 保证)、`tags.json` 与 `plugin_manifest.json` 的 `uniqueItems`(脚本分别只警告与静默去重)、`collection-meta.schema.json` 对 `DOWNLOAD_COUNT_API` 的类型约束(脚本在关闭下载计数时不读它)。这类差异必须写在 `description` 或 `$comment` 中,不允许默默存在。

## 命名与引用约定

- 文件名与所约束的 JSON 同名,后缀 `.schema.json`;`runtime/meta.json` 沿用既有命名,未改。
- `$id` 固定为该文件在本仓库 Pages 上的地址,即 `https://omds-chat.github.io/dsc-plugin-set-template/schemas/<文件名>`,与仓库路径一一对应。
- 每个 Schema 自包含,不引用外部文件,也不跨文件 `$ref`。插件名正则写在 `plugins.schema.json`、`plugin-manifest.schema.json` 与 `runtime/meta.json`,版本号正则写在 `versions.schema.json` 与 `runtime/meta.json`,改动时逐处同改,并与 `collection-verify.mjs` 的 `PLUGIN_NAME_PATTERN`、`SEMVER_PATTERN` 逐字一致。作者名正则写在 `author-manifest.schema.json` 与 `plugins.schema.json`,与 `collection-verify.mjs` 的 `AUTHOR_NAME_PATTERN` 表达同一条规则:JSON Schema 的正则没有 flags,因此写成等价的大小写不敏感形式 `[a-zA-Z\d]`,并配 `maxLength` 39。
- 合集根 `meta.json` 的 Schema 文件名带 `collection-` 前缀,用来区别 `runtime/meta.json` 约束的插件版本目录 `meta.json`。
