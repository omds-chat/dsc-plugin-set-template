# awesome-dsc-plugin-set-template

A template for dsc plugin collections. Copy this repository and you get a collection that follows distribution specification v2: the directory skeleton, JSON Schemas, signing tools and a consistency checker are all included.

This repository is not a plugin collection. It ships the skeleton and the specification only, and indexes no plugins.

[简体中文](README.md)

## What you get

| Item | Location | Purpose |
|:---:|:---:|:---:|
| Collection skeleton | `template/` | Copy it to the root of a new repository and start |
| JSON Schemas | `schemas/` | Validate collection metadata, manifests, versions and signature shapes |
| Signing tools | `scripts/sign.mjs` | Pure functions for Ed25519 hash-then-sign signing and verification |
| Verification and build | `scripts/build-collection.mjs`, `scripts/verify-collection.mjs` | One command to check consistency and produce distribution content |
| Build and deploy pipeline | `.github/workflows/build-and-deploy.yml` | Verify and publish automatically on every push to main |

## Directory layout

```text
.
├── .github/workflows/build-and-deploy.yml   build and deploy pipeline
├── .gitattributes                          enforce LF line endings
├── .gitignore
├── LICENSE
├── README.md
├── README.en-US.md
├── package.json
├── pnpm-workspace.yaml
├── schemas/                                all JSON Schemas
│   ├── runtime/meta.json                   plugin runtime metadata
│   ├── runtime/plugin_sign.json            plugin signature manifest
│   ├── sign/plugin_set_sign.json           collection trust signature
│   └── collection/                         collection metadata, manifests, versions
├── scripts/
│   ├── sign.mjs                            signing and verification tools
│   ├── build-collection.mjs                verify, then produce distribution content
│   ├── verify-collection.mjs               consistency check
│   └── lib/collection-verify.mjs           shared verification logic
└── template/                               collection skeleton, copy and use
    ├── meta.json
    ├── plugin_secret.pub
    ├── plugin_set_sign.json
    ├── datalog.json
    ├── tags.json
    ├── author_manifest.json
    └── plugins/
        └── README.md                       naming rules for author and plugin directories
```

## Create a collection from this template

1. Create a new repository and copy everything under `template/` to its root.
2. Edit `meta.json`. Download counting is off by default. To enable it, set `DOWNLOAD_COUNT_ENABLE` to `true` and provide both `DOWNLOAD_COUNT_API` and `API_NEED_IP`.
3. Generate the collection public key: run `node scripts/sign.mjs derive-public-key <private-key-path> > plugin_secret.pub`. The placeholder key must be replaced.
4. Hand `plugin_secret.pub` to the dsc maintainers and receive one `{ "value": "...", "signer": "dsc" }` entry in `plugin_set_sign.json`. The trust signature covers the bytes of that file, so a new key means a new signature.
5. Create author and plugin directories under `plugins/`. Naming rules are in `template/plugins/README.md`.
6. Register plugins in `datalog.json`, declare preset tags in `tags.json` and register authors in `plugins/author_manifest.json`.
7. Run `pnpm verify` to confirm consistency, then `pnpm build` to produce `dist/`.

## How the trust chain works

Three signing layers. Each layer signs only what the next layer needs.

| Layer | Signer | Private key | Signed object | Artifact |
|:---:|:---:|:---:|:---:|:---:|
| dsc | `dsc` | organization key `WEB_PRIVATE_KEY` | bytes of the collection root `plugin_secret.pub` | `plugin_set_sign.json` |
| Collection | collection name | collection key `PLUGIN_PRIVATE_KEY` | `meta.json` and `plugin.js` of each version | `plugin_sign.json` inside the version directory |
| Author | author name | author key `AUTHOR_SIGN_PRIVATE_KEY` | same files, optional | appended to the same `plugin_sign.json` |

- The plugin market embeds the dsc public key. It validates `plugin_set_sign.json` first, trusts the collection `plugin_secret.pub` only after that, and then uses it to validate plugin signatures.
- Delegation is not supported. A collection cannot issue a trust signature for another collection.
- The algorithm is fixed to Ed25519 with hash-then-sign: hash the file bytes with SHA-512, sign the digest, encode the signature as base64.
- Author self-signatures and collection signatures coexist in one `plugin_sign.json` and are distinguished by the `signer` field. The market records author self-signatures and surfaces them to users.

## Verification rules

`pnpm verify` checks each item below and exits non-zero with the full problem list if any of them fails.

| # | Rule |
|:---:|:---:|
| 1 | `plugin_secret.pub` exists in the root and is a valid Ed25519 SPKI PEM public key |
| 2 | `plugin_set_sign.json` exists in the root and at least one signature verifies with the dsc public key |
| 3 | Every `plugin_name` in `datalog.json` appears in `plugins/<author>/plugin_manifest.json` and its plugin directory exists |
| 4 | Every plugin directory has `versions.json` and `latest` is present in `versions` |
| 5 | Every version directory has `meta.json`, `plugin.js` and `plugin_sign.json`, and the signature file covers the first two |
| 6 | Collection signatures verify with the collection public key, author self-signatures with `plugins/<author>/plugin_secret.pub` |
| 7 | When `tags.json` exists, every `tag` in `datalog.json` comes from it |

## Signing tool API

`scripts/sign.mjs` exports the pure functions below. They assume no repository layout and can be imported anywhere.

| Function | Description |
|:---:|:---:|
| `loadPrivateKey(pem)` | Load a PKCS#8 PEM private key |
| `loadPublicKey(pem)` | Load an SPKI PEM public key |
| `derivePublicKey(pem)` | Derive the public key PEM from a private key |
| `digestSha512(buffer)` | Compute the SHA-512 digest |
| `signDigest(buffer, privateKeyPem)` | Sign the digest and return base64 |
| `signFile(filePath, privateKeyPem, signer)` | Sign one file and return `{ value, for, signer }` |
| `verifyFile(filePath, signatureBase64, publicKeyPem)` | Verify one file and return a boolean |
| `buildSignFile(entries)` | Build a `{ "sign": [...] }` structure |
| `readSignFile(path)` | Read and validate a `plugin_sign.json` structure |

## Verification and deployment

- Locally: run `pnpm install` and then `pnpm verify`. `pnpm build` writes distribution content to `dist/` once verification passes.
- Automation: a push to main or a manual `build-and-deploy` run installs dependencies, runs `scripts/verify-collection.mjs`, signs plugins with the keys from secrets, builds `dist/` and publishes it to Pages.
- Signing keys come from secrets only. `WEB_PRIVATE_KEY` derives the dsc trust public key, `PLUGIN_PRIVATE_KEY` signs plugins, and no private key is ever stored in the repository.
- Distribution must allow cross-origin access, and must allow `omdsc-dev.github.io` at the very least.

## Security notes

- Keep private keys in CI secrets and local environment variables, never in the repository. `.gitignore` already excludes `.env`.
- Replacing the collection key invalidates every trust signature dsc has issued, so request a new one. `build-collection.mjs --sign` fails when the public key derived from the private key does not match the committed `plugin_secret.pub`.
- Signatures cover file bytes. Any change to line endings, indentation or whitespace breaks verification, and the repository uses LF everywhere.
- Minify plugin artifacts. It reduces size and removes meaningless whitespace differences.
- Never bypass a failed verification. The messages name the exact file and signer.

## License

Apache License 2.0, see [LICENSE](LICENSE).
