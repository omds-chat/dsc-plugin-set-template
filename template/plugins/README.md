# 插件目录

本目录存放合集收录的全部插件,按「作者 / 插件 / 版本」三层组织。

## 作者目录

`plugins/<author>/`

- 目录名即作者英文名称,必须与 `datalog.json` 的 `author`、`plugins/author_manifest.json` 的 `username` 一致。
- 仅允许小写字母、数字、连字符,不得以连字符开头或结尾。
- 作者目录内必需两个文件:
  - `plugin_secret.pub`:作者公钥,SPKI PEM,Ed25519。作者启用自签名时用于校验自签名。
  - `plugin_manifest.json`:该作者的插件名数组,例如 `["dsc-demo"]`。

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

- `meta.json`:插件运行时元数据,遵循 `schemas/runtime/meta.json`。
- `plugin.js`:插件运行时脚本,单文件 ESM,使用 LF 换行。
- `plugin_sign.json`:对 `meta.json` 与 `plugin.js` 的签名,至少包含合集签名,作者自签名可选。

## 目录示例

```text
plugins/
  alice/
    plugin_secret.pub
    plugin_manifest.json
    dsc-demo/
      versions.json
      1.0.0/
        meta.json
        plugin.js
        plugin_sign.json
```

合集根目录还需要 `datalog.json`、`tags.json`、`meta.json`、`plugin_set_sign.json`、`plugin_secret.pub`。
