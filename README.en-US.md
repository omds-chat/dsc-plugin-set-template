# dsc-plugin-set-template

A template for plugin collections in the dsc ecosystem. Copy this repository and you get a collection that follows distribution specification v2: the directory skeleton, JSON Schemas, OpenSSL PKI signing tools and a consistency checker are all included.

This repository is not a plugin collection. It ships the skeleton and the specification only, and indexes no plugins.

[简体中文](README.md)

## What you get

| Item | Location | Purpose |
|:---:|:---:|:---:|
| Collection skeleton | `template/` | Copy it to the root of a new repository and start |
| JSON Schemas | `schemas/` | Validate collection metadata, manifests and versions |
| Signing tools | `scripts/pki.mjs` | Wrap openssl root CA, EEC, CMS signing and author signing in functions |
| Verification and build | `scripts/build-collection.mjs`,`scripts/verify-collection.mjs` | One command to check consistency and produce distribution content |
| Plugin import | `scripts/import-plugins.mjs` | Build plugins from a source manifest and copy author signatures and keys |
| Build and deploy pipeline | `.github/workflows/build-and-deploy.yml` | Verify and publish automatically on every push to main |

## Documentation map

The index of all documents, their layering and the conflict resolution order live in [docs/README.md](docs/README.md).

| What you want to do | Where to go |
|:---:|:---:|
| Take a collection from zero to distributable: creation steps, signing and the certificate chain, verification rules, deployment, security notes | [docs/user/collection-guide.en-US.md](docs/user/collection-guide.en-US.md) (Chinese: [collection-guide.md](docs/user/collection-guide.md)) |
| Learn why a design decision was made and where the boundaries are | [docs/design/collection-contract.md](docs/design/collection-contract.md) |
| Look up the plugin tree layout, the required files per layer and the manifest baseline | [template/plugins/README.md](template/plugins/README.md) (the authoritative source of the plugin tree layout) |
| Map JSON fields to script checks | [schemas/README.md](schemas/README.md) |

## Directory layout

```text
.
├── .github/
│   ├── plugins-sources.json                plugin source manifest, read by import-plugins.mjs
│   └── workflows/build-and-deploy.yml      build and deploy pipeline
├── .gitattributes                          enforce LF line endings
├── .gitignore
├── LICENSE
├── README.md
├── README.en-US.md
├── docs/
│   ├── README.md                           document index: responsibility, layering and conflict order of every document
│   ├── design/
│   │   └── collection-contract.md          design document: skeleton, collection id, certificate resolution, build vs verify duties, manifest persistence
│   └── user/
│       ├── collection-guide.md             collection operations guide (Chinese): from zero to a distributable collection
│       └── collection-guide.en-US.md       English edition of the guide, section-by-section with the Chinese one
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── schemas/
│   ├── README.md                           schema index and script-rule mapping
│   ├── manifest.schema.json                three-layer hash manifest
│   ├── collection-meta.schema.json         collection root meta.json
│   ├── plugins.schema.json                 collection root plugins.json, the plugin directory index
│   ├── tags.schema.json                    collection root tags.json
│   ├── author-manifest.schema.json         plugins/author_manifest.json
│   ├── plugin-manifest.schema.json         plugins/<author>/plugin_manifest.json
│   ├── versions.schema.json                plugins/<author>/<plugin>/versions.json
│   └── runtime/meta.json                   plugin runtime metadata
├── scripts/
│   ├── pki.mjs                             OpenSSL PKI wrapper
│   ├── build-collection.mjs                sign, verify, then produce distribution content
│   ├── verify-collection.mjs               consistency check
│   ├── import-plugins.mjs                  import plugins from a manifest
│   └── lib/collection-verify.mjs           shared verification logic
└── template/                               collection skeleton, copy and use
    ├── certs/
    │   └── template/
    │       └── _REPLACE_THIS_FILE_AS_YOUR_EEC_
    │                                       placeholder file, replace with certs/<collection id>/<collection id>-eec.crt
    ├── meta.json
    ├── plugins.json
    ├── tags.json
    ├── manifest.json                       empty L1 baseline before the first build, rewritten by pnpm build
    └── plugins/
        ├── author_manifest.json
        └── README.md                       authoritative plugin tree layout: three layers, required files and the manifest baseline
```

## Minimum viable steps

The full steps, signing material preparation and placeholder replacement are in [section 1 of the operations guide](docs/user/collection-guide.en-US.md). The gist:

1. Copy `template/` to the new repository root, plus `scripts/`, `package.json`, `schemas/` and `.github/`.
2. Generate the EEC private key and CSR, hand them to the root CA (the `DeepSeek-Chat-Enhanced` repository), and write the certificate to `certs/<collection id>/<collection id>-eec.crt`, deleting the placeholder.
3. Put the private key into the CI secret `EEC_SECRET_KEY`, and the root certificate into `secrets.DS_CHAT_ROOT_CA` or its URL into `vars.ROOT_CA_URL`.
4. Create author, plugin and version directories and register the indexes, list plugin sources in `.github/plugins-sources.json`, then run `pnpm import`, `pnpm verify` and `pnpm build` in order.
5. Create the archive parallel branch for the three-layer manifests (currently named `ci-memory`), then push to trigger `build-and-deploy` for publication.

## License

Apache License 2.0, see [LICENSE](LICENSE).
