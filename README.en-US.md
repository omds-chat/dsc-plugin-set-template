# awesome-dsc-plugin-set-template

A template for dsc plugin collections. Copy this repository and you get a collection that follows distribution specification v2: the directory skeleton, JSON Schemas, OpenSSL PKI signing tools and a consistency checker are all included.

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
├── package.json
├── pnpm-workspace.yaml
├── schemas/
│   ├── README.md                           schema index and script-rule mapping
│   ├── manifest.schema.json                three-layer hash manifest
│   ├── collection-meta.schema.json         collection root meta.json
│   ├── datalog.schema.json                 collection root datalog.json
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
    ├── eec.pem                             placeholder certificate, must be replaced
    ├── meta.json
    ├── datalog.json
    ├── tags.json
    └── plugins/
        ├── author_manifest.json
        └── README.md                       three-layer layout and required files
```

## Create a collection from this template

1. Create a new repository and copy everything under `template/` to its root.
2. Generate the EEC private key and a certificate signing request locally:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out eec_secret.pem
openssl req -new -key eec_secret.pem -out eec.csr -subj '/O=omdsc-dev/CN=<collection-name>'
```

3. Hand `eec.csr` to the root CA (the `DeepSeek-Chat-Enhanced` repository) and overwrite the root `eec.pem` with the issued certificate. The `eec.pem` shipped in the skeleton is a placeholder and must not be used for real signing.
4. Put `eec_secret.pem` into the CI secret `EEC_SECRET_KEY`. Put the root certificate into `secrets.ROOT_CA_PEM`, or put the online-data URL of the root certificate into `vars.ROOT_CA_URL`. Never commit a private key.
5. Edit `meta.json`. Download counting is off by default. To enable it, set `DOWNLOAD_COUNT_ENABLE` to `true` and provide both `DOWNLOAD_COUNT_API` and `API_NEED_IP`.
6. Create author and plugin directories under `plugins/`. Naming rules and required files are in `template/plugins/README.md`. Register plugins in `datalog.json`, declare preset tags in `tags.json` and register authors in `plugins/author_manifest.json`.
7. Register plugin sources in `.github/plugins-sources.json`, run `pnpm import` to import them, run `pnpm verify` to confirm consistency, then run `pnpm build` to produce `dist/`.

## Signing and the certificate chain

### Three roles

| Role | Holder | Material | Responsibility |
|:---:|:---:|:---:|:---:|
| Root CA | `DeepSeek-Chat-Enhanced` repository | root private key (offline, never committed), root certificate | Issue end-entity signing certificates (EEC), maintain the revocation list |
| End-entity signer (EEC) | a collection repository such as `awesome-dsc-plugin` | EEC private key (CI secret), `eec.pem` | Sign plugin files with detached CMS signatures |
| Independent signer | plugin authors, omdsc-dev included | author key pair | Append an author signature with a bare public key |

### Algorithms and formats

| Item | Convention |
|:---:|:---:|
| Root CA key | ECDSA P-256, native OpenSSL PEM; self-signed certificate with `keyUsage=critical,keyCertSign,cRLSign`,`basicConstraints=critical,CA:TRUE,pathlen:0`, valid for 3650 days. WebCrypto support for P-256 is the broadest, certificate chain validation happens in the browser, and Ed25519 is unavailable on the target browser floor |
| EEC key | ECDSA P-256, native OpenSSL PEM. The CMS implementation of OpenSSL reports `provider signature failure` for Ed25519, so Ed25519 cannot be used here |
| EEC certificate | Issued by the root CA, `keyUsage=critical,digitalSignature`,`basicConstraints=critical,CA:FALSE`, valid for 365 days |
| Collection signature | Detached CMS signature, `openssl cms -sign -binary -md sha512 -outform DER -nocerts -noattr`, stored as `<file>.sig`. Both signing and verification pass `-binary`, so raw bytes are signed without line-ending canonicalisation. The artifact is always DER and verification passes `-inform DER`. DER is the cross-repository format: browsers cannot parse the default S/MIME `multipart/signed` wrapper, and the plugin market verifies signatures in the browser |
| Author signature | Detached bare public key signature, `openssl pkeyutl -sign -rawin` (Ed25519), stored as `<file>.author.sig` |

### Commands

Root CA (offline, only in the organisation signing environment):

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out root_secret.pem
openssl req -x509 -new -key root_secret.pem -days 3650 -out root_ca.crt \
  -subj '/O=omdsc-dev/CN=omdsc-dev Root CA' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0'
```

The root CA issues the EEC. Note that `openssl x509 -req` rejects `-addext`, so extensions must be passed through `-extfile`:

```bash
openssl x509 -req -in eec.csr -CA root_ca.crt -CAkey root_secret.pem -CAcreateserial \
  -out eec.pem -days 365 \
  -extfile <(printf 'keyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n')
```

Collection signing and verification. The three manifests and `plugin.js` share one command and differ only in the file name:

```bash
openssl cms -sign -binary -md sha512 -outform DER -in manifest.json -out manifest.json.sig -signer eec.pem -inkey eec_secret.pem -nocerts -noattr
openssl cms -verify -binary -md sha512 -inform DER -in manifest.json.sig -content manifest.json -CAfile root_ca.crt -certfile eec.pem
```

`-md sha512` pins the digest algorithm instead of relying on the OpenSSL default. `-outform DER` is not optional. The default output is an S/MIME `multipart/signed` wrapper, which browsers cannot parse, and the plugin market verifies signatures in the browser. DER is therefore the cross-repository format: signers always pass `-outform DER` and verifiers always pass `-inform DER`, and either side falling back to the default format breaks verification. Confirm the artifact with `openssl asn1parse -inform DER -in manifest.json.sig`.

Author signing and verification:

```bash
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in plugin.js -out plugin.js.author.sig
openssl pkeyutl -verify -pubin -inkey author_pub.pem -rawin -in plugin.js -sigfile plugin.js.author.sig
```

To enable revocation checking, concatenate the root certificate and the CRL into a single `-CAfile` and add `-crl_check`: `cat root_ca.crt crl.pem > ca_with_crl.pem`, then verify with `-CAfile ca_with_crl.pem -crl_check`. The `cms` subcommand in OpenSSL 3.5 has no `-CRLfile` option, so the CRL can only travel inside `-CAfile`.

### Distribution layout

```text
<collection>/
├── eec.pem                    # end-entity signing certificate, shipped with Pages, covered by no manifest
├── meta.json                  # L1
├── datalog.json               # L1
├── tags.json                  # L1
├── manifest.json              # L1 manifest
├── manifest.json.sig          # L1 manifest signature
└── plugins/
    ├── author_manifest.json   # L1
    └── <author>/
        ├── author_pub.pem         # L2, author public key, OpenSSL PEM, Ed25519
        ├── plugin_manifest.json   # L2
        ├── manifest.json          # L2 manifest
        ├── manifest.json.sig      # L2 manifest signature
        └── <plugin>/
            ├── versions.json      # L3
            ├── manifest.json      # L3 manifest
            ├── manifest.json.sig  # L3 manifest signature
            └── <x.y.z>/
                ├── meta.json          # L3
                ├── plugin.js
                ├── plugin.js.sig        # collection CMS signature, covers the artifact itself
                └── plugin.js.author.sig # author bare public key signature, optional
```

Distribution uses three hash-manifest layers, each with one `manifest.json` and one `manifest.json.sig`:

| Layer | Location | Covered files (relative to the layer directory) |
|:---:|:---:|:---:|
| L1 | collection root | `meta.json`, `datalog.json`, `plugins/author_manifest.json` required, `tags.json` optional |
| L2 | `plugins/<author>/` | `author_pub.pem`, `plugin_manifest.json` |
| L3 | `plugins/<author>/<plugin>/` | `versions.json`, `<version>/meta.json` |

Manifest format, with the JSON Schema in `schemas/manifest.schema.json`:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "files": [
    { "path": "datalog.json", "sha512": "<128 lowercase hex characters>" }
  ]
}
```

- `path` is relative to the directory holding the manifest, uses forward slashes, and may not contain `..`, be absolute, or point at the manifest itself.
- The hash is SHA-512, lowercase hex.
- `revision` is a positive integer per layer: it increments when the layer's file set or contents change, keeps its value when nothing changed, and starts at 1 without a previous manifest.
- L3 does not cover `plugin.js` or `plugin.js.sig`: the artifact itself is signed per version by `plugin.js.sig`, and the manifest describes metadata only.
- `tags.json` is optional: when it exists it must be covered by the L1 manifest, and when it does not exist it is neither required nor listed.
- `meta.json.sig` is gone: the only collection signature inside a version directory is `plugin.js.sig`, and `plugin.js.author.sig` stays optional. `meta.json.author.sig` is dropped as well: `meta.json` is covered by the L3 manifest and bound by the collection EEC, while the author public key itself is covered by L2. The `dsc-plugin-template` repository still emits that file and has to be synced.
- `meta.json`, `datalog.json`, `tags.json`, `plugins/author_manifest.json`, `plugins/<author>/plugin_manifest.json`, `plugins/<author>/<plugin>/versions.json` and the three-layer `manifest.json` each have a JSON Schema in `schemas/`. The index, mapping every script rule to the constraint that mirrors it, is in [`schemas/README.md`](schemas/README.md).

The three layers are deliberately not folded together: L1 does not reference L2 and L2 does not reference L3, so each layer can be published, verified and re-signed on its own. The trade-off gives up "one check yields a digest of the whole tree" in exchange for per-plugin incremental updates: changing one plugin only increments the L3 `revision`, leaves L2 and L1 untouched, and clients refetch just that layer. Folding the layers into a single root manifest would make every plugin release rewrite the root manifest and force every client to refetch the whole digest.

The old `plugin_secret.pub` and `plugin_set_sign.json` are gone. A collection is trusted because its EEC chains to the root CA, so no separate trust signature is issued. The root certificate is not part of `dist/`: it is distributed through the online-data branch and pinned by fingerprint inside the web client.

## Signing and verification

### What gets signed

| Signature | Covers | Artifact |
|:---:|:---:|:---:|
| Collection CMS signature | one manifest per layer, L1 to L3 | `manifest.json.sig`, one per layer |
| Collection CMS signature | `plugin.js` of every version | `plugin.js.sig` |
| Author bare public key signature | `plugin.js`, optional | `plugin.js.author.sig` |

The command is always `openssl cms -sign -binary -md sha512 -outform DER -nocerts -noattr` with the artifact written to `<file>.sig`. `meta.json` is no longer signed separately: the L3 manifest covers it by SHA-512.

### Verification rules

`pnpm verify` checks each item below and exits non-zero with the full problem list if any of them fails. Every problem names its layer and file path.

| # | Rule |
|:---:|:---:|
| 1 | `eec.pem` exists in the root, chains to the given root certificate (`--root-ca` or `ROOT_CA_PATH`), is not expired, has `digitalSignature` in `keyUsage` and is not a CA |
| 2 | Every plugin in `datalog.json` appears in `plugins/<author>/plugin_manifest.json` and its plugin directory exists |
| 3 | Every plugin directory has `versions.json` and `latest` is present in `versions` |
| 4 | Every version directory has `meta.json`, `plugin.js` and `plugin.js.sig`, verified with `openssl cms -verify -binary -md sha512 -inform DER -CAfile <root> -certfile eec.pem`; a failure is an error |
| 5 | When `plugin.js.author.sig` exists in a version directory, `plugins/<author>/author_pub.pem` must exist and the signature must verify with `openssl pkeyutl -verify`; a failure is an error. Other `*.author.sig` files are not checked |
| 6 | When `tags.json` exists, every `tag` in `datalog.json` comes from it |
| 7 | All three manifests exist and are structurally valid: `schemaVersion` is 1, `revision` is a positive integer, `files` is a non-empty array, and each entry holds only `path` and `sha512` |
| 8 | Every `path` is valid: forward slashes, relative, no `..`, not the manifest itself, no duplicates |
| 9 | Coverage matches the layer exactly: every required file is listed and nothing extra is, so L3 never lists `plugin.js` or `plugin.js.sig` |
| 10 | Every recorded SHA-512 matches the file contents, and a mismatch names the layer and the file |
| 11 | Every `manifest.json.sig` verifies against the root certificate and `eec.pem`; a failure is an error |

`pnpm verify` passes `--allow-placeholder-eec` by default so the skeleton itself can be checked: a missing root certificate, an `eec.pem` that does not chain to it, or manifests and manifest signatures that do not exist yet become warnings. A real collection's CI does not pass that flag; `--allow-missing-manifest` relaxes only the missing-manifest and missing-signature errors while structure and hash checks still run.

Verification has two levels. The scripts here are a strict pre-release gate and fail hard. On the plugin market side, certificate chain checks, plugin signature checks and web asset signature checks only warn: they never block and never fall back.

## Signing tool API

`scripts/pki.mjs` only drives openssl and implements no cryptography itself. Every function is synchronous and throws `PkiError` on failure; the `verify*` family returns `{ ok, reason }` instead, so all problems can be collected in one pass.

| Function | Description |
|:---:|:---:|
| `genRootCa(dir)` | Generate an ECDSA P-256 root key and a self-signed root certificate, returns `{ keyPath, certPath }` |
| `genEecKey(dir)` | Generate an ECDSA P-256 EEC private key |
| `genCsr(dir, commonName, org)` | Generate a CSR from an existing EEC private key |
| `issueEec(csr, rootCrt, rootKey, out)` | Issue the EEC certificate, passing extensions through a temporary `--extfile` |
| `signFileCms(file, eecCrt, eecKey)` | Produce a detached CMS signature as `<file>.sig` |
| `verifyFileCms(file, sig, rootCrt, eecCrt)` | Verify a detached CMS signature against the root certificate |
| `signManifest(manifest, eecCrt, eecKey)` | Sign a manifest and write `<manifest>.sig`, same parameters as `signFileCms` |
| `verifyManifest(manifest, sig, rootCrt, eecCrt)` | Verify a manifest signature |
| `genAuthorKey(dir)` | Generate an author Ed25519 key pair, returns `{ keyPath, pubPath }` |
| `signFileAuthor(file, authorKey)` | Produce an author signature as `<file>.author.sig` |
| `verifyFileAuthor(file, sig, authorPub)` | Verify an author signature |
| `describeCertificate(certPath)` | Read subject, issuer, validity, `keyUsage` and `basicConstraints` |
| `verifyChain(certPath, rootCrt)` | Equivalent to `openssl verify -CAfile <root> <cert>` |
| `certMatchesKey(certPath, keyPath)` | Tell whether a certificate and a private key belong together, used before signing |

## Verification and deployment

- Locally: run `pnpm install`, then `pnpm verify`. `pnpm build` first materialises and signs the three manifests, then verifies, then writes distribution content to `dist/`; with `--sign` it signs `plugin.js` and the three manifests with `EEC_SECRET_KEY`.
- The three `manifest.json` and `manifest.json.sig` files must be committed together with the collection source. A revision is read back from the previous manifest of the same layer, so leaving them out of version control resets every layer to 1 on a fresh checkout and breaks revision continuity across CI runs.
- Automation: a push to main or a manual `build-and-deploy` run installs dependencies, imports plugins from the manifest, resolves the root certificate, checks the `eec.pem` chain with `openssl verify`, signs with `EEC_SECRET_KEY` and builds `dist/`, runs a full verification on `dist/` and finally publishes to Pages.
- The root certificate comes from one of two places: `secrets.ROOT_CA_PEM` (PEM text) wins, otherwise `vars.ROOT_CA_URL` is fetched from the online-data branch.
- Signing keys come from secrets only. No private key is ever stored in the repository.
- Distribution must allow cross-origin access, and must allow `omdsc-dev.github.io` at the very least.

## Security notes

- Keep the root private key offline and use it only to issue EECs or generate a CRL. Keep the EEC private key and author keys in CI secrets and local environment variables. `.gitignore` already excludes `.env`.
- If `eec.pem` is replaced or the private key leaks, ask the root CA to revoke it and issue a new one. Once `crl.pem` exists, verifiers add `--crl_check` and the revocation takes effect.
- Signatures cover file bytes. CMS signatures use `-binary` and author signatures use `-rawin`, so both are byte-exact: any change to line endings, indentation or whitespace breaks verification, and converting LF to CRLF fails as well. The repository uses LF everywhere.
- `build-collection.mjs --sign` first confirms that `EEC_SECRET_KEY` matches the committed `eec.pem` and fails otherwise, so it never produces signatures nobody can verify.
- Never bypass a failed verification. The messages name the exact file and the reason.

## License

Apache License 2.0, see [LICENSE](LICENSE).
