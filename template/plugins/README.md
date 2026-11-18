# 插件目录

本目录存放合集收录的全部插件,按「作者 / 插件 / 版本」三层组织。三层都参与签名:合集用根 CA 签发的终端签名证书(EEC)给每个版本的文件生成 CMS 分离签名,作者可选地用自有密钥追加一份裸公钥分离签名。

## 作者目录

`plugins/<author>/`

- 目录名即作者英文名称,必须与 `datalog.json` 的 `author`、`plugins/author_manifest.json` 的 `username` 一致。
- 仅允许小写字母、数字、连字符,不得以连字符开头或结尾。

| 文件 | 必需 | 说明 |
|:---:|:---:|:---:|
| `plugin_manifest.json` | 是 | 该作者的插件名数组,例如 `["dsc-demo"]` |
| `author_pub.pem` | 否 | 作者公钥,OpenSSL PEM,Ed25519。版本目录出现 `<文件>.author.sig` 时必须存在 |

## 插件目录

`plugins/<author>/<plugin>/`

- 目录名取插件 npm 包名去掉命名空间前缀,例如 `@alice/dsc-demo` 写作 `dsc-demo`。
- 目录内必需 `versions.json`:

```json
{
  "latest": "1.0.0",
  "versions": ["1.0.0", "0.9.0"]
}
```

- `latest` 必须出现在 `versions` 内;`versions` 按版本号降序排列且不得重复。

## 版本目录

`plugins/<author>/<plugin>/<x.y.z>/`

| 文件 | 必需 | 说明 |
|:---:|:---:|:---:|
| `meta.json` | 是 | 插件运行时元数据,遵循 `schemas/runtime/meta.json` |
| `meta.json.sig` | 是 | 合集 CMS 分离签名,由 EEC 生成 |
| `plugin.js` | 是 | 插件运行时脚本,单文件 ESM,使用 LF 换行 |
| `plugin.js.sig` | 是 | 合集 CMS 分离签名,由 EEC 生成 |
| `meta.json.author.sig` | 否 | 作者裸公钥分离签名,存在时用 `plugins/<author>/author_pub.pem` 校验 |
| `plugin.js.author.sig` | 否 | 作者裸公钥分离签名,同上 |

合集签名由 `scripts/build-collection.mjs --sign` 在 CI 中用 `EEC_SECRET_KEY` 生成,仓库内不存放任何私钥。作者签名由作者自己的构建流程生成,`scripts/import-plugins.mjs` 会把插件产物里的 `plugin.js.sig`、`meta.json.sig` 与 `author_pub.pem` 分别落成上述文件名。

## 目录示例

```text
plugins/
  alice/
    author_pub.pem
    plugin_manifest.json
    dsc-demo/
      versions.json
      1.0.0/
        meta.json
        meta.json.sig
        plugin.js
        plugin.js.sig
        plugin.js.author.sig
```

合集根目录还需要 `eec.pem`、`datalog.json`、`meta.json`、`tags.json`。旧的 `plugin_secret.pub` 与 `plugin_set_sign.json` 已废弃,由 `eec.pem` 的证书链取代。
