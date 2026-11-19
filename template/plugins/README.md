# 插件目录

本目录存放合集收录的全部插件,按「作者 / 插件 / 版本」三层组织。每层一份 `manifest.json` 与一份 `manifest.json.sig`:清单记录本层文件的 SHA-512,签名由根 CA 签发的终端签名证书(EEC)生成。产物本体另有每版本的 `plugin.js.sig`,作者可选地用自有密钥追加一份裸公钥分离签名。

## 作者目录

`plugins/<author>/`

- 目录名即作者英文名称,必须与插件目录索引 `plugins.json` 的 `author`、`plugins/author_manifest.json` 的 `username` 一致。
- 目录名必须是合法的 GitHub 用户名,与 GitHub 自身的规则一致:字母或数字开头,其后为字母、数字或单个连字符,不得以连字符结尾,长度不超过 39,不区分大小写。正则写在 `scripts/lib/collection-verify.mjs` 的 `AUTHOR_NAME_PATTERN`,即 `^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$`(带 `i` 标志),Schema 见 `schemas/author-manifest.schema.json` 的 `username.pattern`。
- 目录名不符时 `pnpm verify` 报 `AUTHOR_DIR_NAME_INVALID`,并指出具体的 `plugins/<目录>`。

| 文件 | 必需 | 说明 |
|:---:|:---:|:---:|
| `plugin_manifest.json` | 是 | 该作者的插件名数组,例如 `["dsc-demo"]` |
| `author_pub.pem` | 否 | 作者公钥,OpenSSL PEM,Ed25519。版本目录出现 `<文件>.author.sig` 时必须存在 |
| `manifest.json` | 是 | L2 清单,覆盖本目录的 `author_pub.pem` 与 `plugin_manifest.json` |
| `manifest.json.sig` | 是 | L2 清单的 CMS 分离签名,由 EEC 生成 |

## 插件目录

`plugins/<author>/<plugin>/`

- 目录名取插件 npm 包名去掉命名空间前缀,例如 `@alice/dsc-demo` 写作 `dsc-demo`,因此目录名必然以 `dsc-` 开头。
- 插件名必须带 `dsc-` 前缀:全局包为 `dsc-xxx`,命名空间包为 `@scope/dsc-xxx`。插件目录索引 `plugins.json` 的 `plugin_name` 与 `plugin_manifest.json` 的每一项都按 `scripts/lib/collection-verify.mjs` 的 `PLUGIN_NAME_PATTERN` 校验,缺前缀时 `pnpm verify` 分别报 `PLUGINS_INDEX_INVALID`、`PLUGIN_MANIFEST_INVALID`。
- 目录内必需 `versions.json`:

```json
{
  "latest": "1.0.0",
  "versions": ["1.0.0", "0.9.0"]
}
```

- `latest` 必须出现在 `versions` 内;`versions` 按版本号降序排列且不得重复。
- 目录内另有 `manifest.json` 与 `manifest.json.sig`,即 L3 清单,覆盖 `versions.json` 与每个版本的 `meta.json`。L3 不覆盖 `plugin.js` 与 `plugin.js.sig`,产物本体由每版本的 `plugin.js.sig` 独立签名。

## 版本目录

`plugins/<author>/<plugin>/<x.y.z>/`

| 文件 | 必需 | 说明 |
|:---:|:---:|:---:|
| `meta.json` | 是 | 插件运行时元数据,遵循 `schemas/runtime/meta.json`;由 L3 清单覆盖,不再单独签名 |
| `plugin.js` | 是 | 插件运行时脚本,单文件 ESM,使用 LF 换行 |
| `plugin.js.sig` | 是 | 合集 CMS 分离签名,由 EEC 生成 |
| `plugin.js.author.sig` | 否 | 作者裸公钥分离签名,存在时用 `plugins/<author>/author_pub.pem` 校验 |

`meta.json` 不接受作者签名:它由 L3 清单覆盖,并由合集 EEC 绑定,作者公钥本身由 L2 覆盖。

合集签名由 `scripts/build-collection.mjs --sign` 在 CI 中用 `EEC_SECRET_KEY` 生成,仓库内不存放任何私钥。作者签名由作者自己的构建流程生成,`scripts/import-plugins.mjs` 会把插件产物里的 `plugin.js.sig` 落成 `plugin.js.author.sig`,并把 `author_pub.pem` 落到作者目录。

## 目录示例

```text
plugins/
  alice/
    author_pub.pem
    plugin_manifest.json
    manifest.json
    manifest.json.sig
    dsc-demo/
      versions.json
      manifest.json
      manifest.json.sig
      1.0.0/
        meta.json
        plugin.js
        plugin.js.sig
        plugin.js.author.sig
```

合集根目录还需要 `certs/<合集 id>-eec.crt`(终端签名证书)、插件目录索引 `plugins.json`、`meta.json`、`tags.json`,以及 L1 清单 `manifest.json` 与 `manifest.json.sig`。合集的可信性由终端签名证书的证书链证明,不另发信任签名。

终端签名证书的解析顺序:

1. `certs/<合集 id>-eec.crt` —— 现行布局,新证书一律放这里。合集 id 依次取 `--collection-name`、分发目录 `build-info.json` 的 `collection` 字段、合集目录名,不写死任何具体合集名。
2. `eec.pem` —— 旧布局回退,仅为兼容尚未迁移的旧合集保留,新合集不得使用,该回退在后续版本删除。命中旧布局时 `pnpm verify` 与 `pnpm build` 都会报 `EEC_LEGACY_LAYOUT` 提示,并给出应改成的文件名。
