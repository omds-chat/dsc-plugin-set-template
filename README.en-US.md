# awesome-dsc-plugin-set-template

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
        └── README.md                       three-layer layout, required files and the manifest baseline
```

## Create a collection from this template

1. Create a new repository and copy everything under `template/` to its root.
2. Also copy `scripts/`, `package.json`, `schemas/` and `.github/` from the root of this template repository into the new repository root. `template/` ships the collection data skeleton only and deliberately excludes those four: without `package.json` and `scripts/` there is no `pnpm verify` or `pnpm build`, without `schemas/` the written contract is gone, and without `.github/` there is no plugin source manifest and no build-and-deploy pipeline. Adjust the placeholders afterwards: `name` and `repository` in `package.json`, the deployment settings in `.github/workflows/build-and-deploy.yml`, and the certificate folder and file name described in step 4.
3. Generate the EEC private key and a certificate signing request locally:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out eec_secret.pem
openssl req -new -key eec_secret.pem -out eec.csr -subj '/O=omds-chat/CN=<collection-name>'
```

4. Hand `eec.csr` to the root CA (the `DeepSeek-Chat-Enhanced` repository) and write the issued certificate to `certs/<collection id>/<collection id>-eec.crt`. The collection id comes from `--collection-name`, otherwise from the `collection` field of `build-info.json` in a distribution directory, otherwise from the collection directory name, which for a new collection is normally its repository name. The skeleton ships `certs/template/`, which does not match a new collection id, so rename it to `certs/<new collection id>/` after copying. `_REPLACE_THIS_FILE_AS_YOUR_EEC_` inside that folder is a placeholder file, not a certificate: replace it with `certs/<new collection id>/<new collection id>-eec.crt` and delete the placeholder. Both signing and verification reject the placeholder; see [Placeholder file and test flow](#placeholder-file-and-test-flow).
5. Put `eec_secret.pem` into the CI secret `EEC_SECRET_KEY`. Put the root certificate into `secrets.ROOT_CA_PEM`, or put its URL into `vars.ROOT_CA_URL`, pointing at `root_ca.crt` on the `certs` branch of `DeepSeek-Chat-Enhanced`; that branch belongs to the root CA repository, not to this one. Never commit a private key.
6. Edit `meta.json`. Download counting is off by default. To enable it, set `DOWNLOAD_COUNT_ENABLE` to `true` and provide both `DOWNLOAD_COUNT_API` and `API_NEED_IP`.
7. Create author and plugin directories under `plugins/`. Naming rules and required files are in `template/plugins/README.md`. Register plugins in the plugin directory index `plugins.json`, declare preset tags in `tags.json` and register authors in `plugins/author_manifest.json`.
8. Register plugin sources in `.github/plugins-sources.json`, run `pnpm import` to import them, run `pnpm verify` to confirm consistency, then run `pnpm build` to produce `dist/`.
9. Create a parallel branch `ci-memory` for the three-layer manifests (see [Parallel branches](#parallel-branches)): run `git checkout --orphan ci-memory`, put a single `README.md` that states its responsibility in the first commit, and check the worktree out under `single-branch/ci-memory/`. It shares no ancestry with `main`, is read and written by the pipeline only, and is never published to Pages. The template repository does not create this branch, and `template/manifest.json` in the skeleton is only the empty baseline before the first build.

## Placeholder file and test flow

### The placeholder file

`template/certs/template/_REPLACE_THIS_FILE_AS_YOUR_EEC_` is a plain text file, not a certificate: it only holds the place of the end-entity signing certificate and reminds you that the slot must become `certs/<collection id>/<collection id>-eec.crt`. The scripts treat it consistently:

| Entry point | Behaviour |
|:---:|:---:|
| `resolveEecCertPath(dir)` | Resolves in the order above; on a placeholder hit `layout` is `placeholder` and `isPlaceholder` is `true`, so callers can tell it apart |
| `build-collection.mjs` | With `--sign` it refuses to sign, reports `EEC_PLACEHOLDER` and names the path to use instead; no signature is produced |
| `verify-collection.mjs` | Reports `EEC_PLACEHOLDER`: a warning in skeleton mode, an error otherwise. The placeholder is never parsed as a certificate, so the chain, validity and `keyUsage` checks are skipped and the CMS checks degrade to "cannot verify" warnings instead of crashing |
| `signFileCms`, `signManifest`, `verifyFileCms` in `pki.mjs` | Refuse outright: signing throws `PkiError`, verification returns `{ ok: false, reason }`, and the message states that the placeholder cannot be used |

Delete the placeholder once the real certificate is in place: `pnpm build` copies the whole `certs/` directory into `dist/`, so a leftover placeholder is distributed as well.

### Trying it out in a temporary test repository

Never edit this repository to try out the skeleton, a script change or a new collection id. Create a temporary test repository inside the workspace, do everything there and delete it afterwards. `temp/` is already ignored by `.gitignore`, so the original repository sees no change from the test.

| Step | Action | Notes |
|:---:|:---:|:---:|
| 1 | Copy the repository to `temp/test-eec/` | `mkdir -p temp/test-eec && cp -r template/. temp/test-eec/ && cp -r scripts schemas .github package.json pnpm-lock.yaml pnpm-workspace.yaml .gitattributes temp/test-eec/`. The temporary repository uses the ready-to-use collection layout: the skeleton sits at its root, with `scripts/` and `schemas/` beside it, so no dependency install is needed |
| 2 | Take the test end-entity signing certificate from the organisation offline keystore and replace the placeholder | Rename `certs/template/` to `certs/<temporary collection id>/` first (the temporary collection id defaults to the directory name `test-eec`), then write the certificate to `certs/<temporary collection id>/<temporary collection id>-eec.crt` and delete the placeholder in that folder. Take the root certificate from the organisation offline keystore as well |
| 3 | Change the collection id and related code in the temporary repository | Use a different id by renaming the folder or by passing `--collection-name`; adjust `meta.json`, `plugins.json`, `tags.json`, `package.json` and `.github/workflows/build-and-deploy.yml` as needed. Only the copy under `temp/` is touched |
| 4 | Run the checks in the temporary repository | `cd temp/test-eec && node scripts/verify-collection.mjs --dir . --root-ca <root certificate path>`. Once the real certificate is in place neither `EEC_PLACEHOLDER` nor `EEC_PLACEHOLDER_LEFT` should appear |
| 5 | Clean up | `rm -rf temp/test-eec`. The test certificate and the root certificate stay in the temporary directory: never commit them |

Everything inside the temporary test repository is temporary: the test certificate, the root certificate and the changed collection id must not flow back into the original repository, whose `certs/` holds the placeholder file only.

## Signing and the certificate chain

### Three roles

| Role | Holder | Material | Responsibility |
|:---:|:---:|:---:|:---:|
| Root CA | `DeepSeek-Chat-Enhanced` repository | root private key (offline, never committed), root certificate | Issue end-entity signing certificates (EEC), maintain the revocation list |
| End-entity signer (EEC) | a collection repository such as `awesome-dsc-plugin` | EEC private key (CI secret), `certs/<collection id>/<collection id>-eec.crt` | Sign plugin files with detached CMS signatures |
| Independent signer | plugin authors, omds-chat included | author key pair | Append an author signature with a bare public key |

### Certificate location

`certs/` under the collection root is split into per-source folders, and both the folder name and the file name come from the signing material itself; the end-entity signing certificate is the collection's own source, so it lives in the folder named after the collection id. The lookup order is fixed:

| # | Path | Notes |
|:---:|:---:|:---:|
| 1 | `certs/<collection id>/<collection id>-eec.crt` | current layout, every real certificate goes here |
| 2 | `certs/<collection id>/_REPLACE_THIS_FILE_AS_YOUR_EEC_` | skeleton placeholder, meaning the slot has not been replaced yet; resolution returns `layout` `placeholder` and `isPlaceholder` `true`, and both signing and verification reject it |
| 3 | `eec.pem` | legacy layout, kept only to read collections that have not migrated; never use it for a new collection, and the fallback is removed in a later release |

A source folder may also carry that source's public key, named with a `.pub` suffix; private keys are never committed. The collection id is resolved as `--collection-name` when given, otherwise the `collection` field of `build-info.json` in the directory (that is how the distribution directory `dist/` reads it back), otherwise the collection directory name. The template repository itself uses its directory name, so its placeholder file is `template/certs/template/_REPLACE_THIS_FILE_AS_YOUR_EEC_`. On a legacy hit both `pnpm verify` and `pnpm build` report `EEC_LEGACY_LAYOUT` and name the path to use instead; on a placeholder hit they report `EEC_PLACEHOLDER` and name the file to replace it with, and when the real certificate is in place but the placeholder is still there verification reports `EEC_PLACEHOLDER_LEFT` so it gets deleted. `pnpm build` copies the whole `certs/` directory into `dist/`, and still copies a root `eec.pem` when one is present so that older verifiers keep working.

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
  -subj '/O=omds-chat/CN=omds-chat Root CA' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0'
```

The root CA issues the EEC. Note that `openssl x509 -req` rejects `-addext`, so extensions must be passed through `-extfile`:

```bash
openssl x509 -req -in eec.csr -CA root_ca.crt -CAkey root_secret.pem -CAcreateserial \
  -out certs/<collection id>/<collection id>-eec.crt -days 365 \
  -extfile <(printf 'keyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n')
```

Collection signing and verification. The three manifests and `plugin.js` share one command and differ only in the file name:

```bash
openssl cms -sign -binary -md sha512 -outform DER -in manifest.json -out manifest.json.sig -signer certs/<collection id>/<collection id>-eec.crt -inkey eec_secret.pem -nocerts -noattr
openssl cms -verify -binary -md sha512 -inform DER -in manifest.json.sig -content manifest.json -CAfile root_ca.crt -certfile certs/<collection id>/<collection id>-eec.crt
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
├── certs/
│   └── <collection id>/
│       └── <collection id>-eec.crt  # end-entity signing certificate, shipped with Pages, covered by no manifest
├── meta.json                  # L1
├── plugins.json               # L1
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
| L1 | collection root | `meta.json`, `plugins.json`, `plugins/author_manifest.json` required, `tags.json` optional |
| L2 | `plugins/<author>/` | `author_pub.pem`, `plugin_manifest.json` |
| L3 | `plugins/<author>/<plugin>/` | `versions.json`, `<version>/meta.json` |

Manifest format, with the JSON Schema in `schemas/manifest.schema.json`:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "files": [
    { "path": "plugins.json", "sha512": "<128 lowercase hex characters>" }
  ]
}
```

- `path` is relative to the directory holding the manifest, uses forward slashes, and may not contain `..`, be absolute, or point at the manifest itself.
- The hash is SHA-512, lowercase hex.
- `revision` is a positive integer per layer: it increments when the layer's file set or contents change, keeps its value when nothing changed, and starts at 1 without a previous manifest.
- L3 does not cover `plugin.js` or `plugin.js.sig`: the artifact itself is signed per version by `plugin.js.sig`, and the manifest describes metadata only.
- `tags.json` is optional: when it exists it must be covered by the L1 manifest, and when it does not exist it is neither required nor listed.
- The only collection signature inside a version directory is `plugin.js.sig`, and `plugin.js.author.sig` stays optional. `meta.json` is neither signed on its own nor accepts an author signature: it is covered by the L3 manifest and bound by the collection EEC, while the author public key itself is covered by L2.
- `meta.json`, `plugins.json`, `tags.json`, `plugins/author_manifest.json`, `plugins/<author>/plugin_manifest.json`, `plugins/<author>/<plugin>/versions.json` and the three-layer `manifest.json` each have a JSON Schema in `schemas/`. The index, mapping every script rule to the constraint that mirrors it, is in [`schemas/README.md`](schemas/README.md).

The three layers are deliberately not folded together: L1 does not reference L2 and L2 does not reference L3, so each layer can be published, verified and re-signed on its own. The trade-off gives up "one check yields a digest of the whole tree" in exchange for per-plugin incremental updates: changing one plugin only increments the L3 `revision`, leaves L2 and L1 untouched, and clients refetch just that layer. Folding the layers into a single root manifest would make every plugin release rewrite the root manifest and force every client to refetch the whole digest.

A collection is trusted because its EEC chains to the root CA, so no separate trust signature is issued. The root certificate is not part of `dist/`: it is distributed through the `certs` branch of `DeepSeek-Chat-Enhanced`, the trust list through the `trusted-manifest` branch of the same repository, and the web client pins the root certificate by fingerprint. Both branches belong to `DeepSeek-Chat-Enhanced`: they are neither branches of this repository nor of a consuming collection repository, and a collection does not reuse those names for its parallel branch.

## Signing and verification

### What gets signed

| Signature | Covers | Artifact |
|:---:|:---:|:---:|
| Collection CMS signature | one manifest per layer, L1 to L3 | `manifest.json.sig`, one per layer |
| Collection CMS signature | `plugin.js` of every version | `plugin.js.sig` |
| Author bare public key signature | `plugin.js`, optional | `plugin.js.author.sig` |

The command is always `openssl cms -sign -binary -md sha512 -outform DER -nocerts -noattr` with the artifact written to `<file>.sig`. `meta.json` is not signed separately: the L3 manifest covers it by SHA-512.

### Verification rules

`pnpm verify` checks each item below and exits non-zero with the full problem list if any of them fails. Manifest problems name their layer, and every problem names its file path.

| # | Rule |
|:---:|:---:|
| 1 | The end-entity signing certificate exists: `certs/<collection id>/<collection id>-eec.crt` is looked up first, then the skeleton placeholder `certs/<collection id>/_REPLACE_THIS_FILE_AS_YOUR_EEC_`, which only reports `EEC_PLACEHOLDER` and is never parsed as a certificate, and only when neither is present does the verifier fall back to a legacy root `eec.pem` and report `EEC_LEGACY_LAYOUT`; a real certificate chains to the given root certificate (`--root-ca` or `ROOT_CA_PATH`), is not expired, has `digitalSignature` in `keyUsage` and is not a CA |
| 2 | Every plugin in the plugin directory index `plugins.json` appears in `plugins/<author>/plugin_manifest.json` and its plugin directory exists |
| 3 | Every plugin directory has `versions.json` and `latest` is present in `versions` |
| 4 | Every version directory has `meta.json`, `plugin.js` and `plugin.js.sig`, verified with `openssl cms -verify -binary -md sha512 -inform DER -CAfile <root> -certfile certs/<collection id>/<collection id>-eec.crt`; a failure is an error |
| 5 | When `plugin.js.author.sig` exists in a version directory, `plugins/<author>/author_pub.pem` must exist and the signature must verify with `openssl pkeyutl -verify`; a failure is an error. Other `*.author.sig` files are not checked |
| 6 | When `tags.json` exists, every `tag` in `plugins.json` comes from it |
| 7 | All three manifests exist and are structurally valid: `schemaVersion` is 1, `revision` is a positive integer, `files` is a non-empty array, and each entry holds only `path` and `sha512` |
| 8 | Every `path` is valid: forward slashes, relative, no `..`, not the manifest itself, no duplicates |
| 9 | Coverage matches the layer exactly: every required file is listed and nothing extra is, so L3 never lists `plugin.js` or `plugin.js.sig` |
| 10 | Every recorded SHA-512 matches the file contents, and a mismatch names the layer and the file |
| 11 | Every `manifest.json.sig` verifies against the root certificate and the end-entity certificate; a failure is an error |
| 12 | Author directory names, `author` in `plugins.json` and `username` in `plugins/author_manifest.json` must all be valid GitHub usernames: `^[a-z\d](?:[a-z\d]\|-(?=[a-z\d])){0,38}$`, case-insensitive, at most 39 characters, with no leading or trailing hyphen. A directory name that does not match reports `AUTHOR_DIR_NAME_INVALID` and names `plugins/<directory>`; a mismatched `author` or `username` reports `PLUGINS_INDEX_INVALID` or `AUTHOR_MANIFEST_INVALID` |
| 13 | Plugin names must carry the `dsc-` prefix. `plugin_name` in `plugins.json` and every entry of `plugins/<author>/plugin_manifest.json` are checked against `PLUGIN_NAME_PATTERN`, that is `^(?:dsc-[a-z0-9][a-z0-9._-]*\|@[a-z0-9][a-z0-9._-]*/dsc-[a-z0-9][a-z0-9._-]*)$`; a missing prefix reports `PLUGINS_INDEX_INVALID` or `PLUGIN_MANIFEST_INVALID` |

`pnpm verify` passes `--allow-placeholder-eec` by default so the skeleton itself can be checked: an end-entity certificate that is still the placeholder file, a missing root certificate, an end-entity certificate that does not chain to it, or manifests and manifest signatures that do not exist yet become warnings. The placeholder is downgraded only in skeleton mode and is never parsed as a certificate; a real collection's CI does not pass that flag, so an unreplaced placeholder is an error there. `--allow-missing-manifest` relaxes only the missing-manifest and missing-signature errors while structure and hash checks still run.

The scripts here are a strict pre-release gate: apart from the flags above, any error blocks the release.

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
| `resolveEecCertPath(dir)` | Resolve the end-entity certificate location, hitting the current layout, then the placeholder file, then the legacy layout, and return `layout` (`certs`, `placeholder`, `legacy`) with `isPlaceholder` |

## Verification and deployment

- Locally: run `pnpm install`, then `pnpm verify`. `pnpm build` first materialises the three manifests, then verifies, then writes distribution content to `dist/`; with `--sign` it signs the three manifests and every version's `plugin.js` with `EEC_SECRET_KEY`.
- The three `manifest.json` and `manifest.json.sig` files must be persisted, but not on the main branch. A revision is read back from the previous manifest of the same layer; when it cannot be read back, the layer restarts at 1 and revision continuity across CI runs is lost. The manifests are therefore committed to an archive branch that shares no ancestry with the main branch, and no commit on the main branch carries a copy of them. The pipeline runs three steps in this order: read back, generate, write back. It first restores the previous manifest of each layer from `layer-manifests/` on the collection repository's own `ci-memory` branch, then generates the new manifests and signatures, then writes both new artifacts back to the matching paths under `ci-memory/layer-manifests/`. The archive branch is named `ci-memory` and groups flat folders by function; only `layer-manifests/` exists here. It is never published to Pages and is read and written by the pipeline only. A write-back failure aborts the release and fails the CI run instead of publishing on a stale ledger; see section 6 of [`docs/design/collection-contract.md`](docs/design/collection-contract.md) for the rationale, the boundaries and the step order.
- Automation: a push to main or a manual `build-and-deploy` run installs dependencies, imports plugins from the manifest, resolves the root certificate, checks the chain of the end-entity signing certificate with `openssl verify`, signs with `EEC_SECRET_KEY` and builds `dist/`, runs a full verification on `dist/` and finally publishes to Pages.
- The root certificate comes from one of two places: `secrets.ROOT_CA_PEM` (PEM text) wins, otherwise `vars.ROOT_CA_URL` is fetched from the `certs` branch of `DeepSeek-Chat-Enhanced`; the trust list is distributed through that repository's `trusted-manifest` branch. Both branches belong to the root CA repository, not to this one.
- Signing keys come from secrets only. No private key is ever stored in the repository.
- Distribution must allow cross-origin access, and must allow `omds-chat.github.io` at the very least.

### Why the template repository does not publish

This repository carries the contract; it is not a collection. It holds no EEC private key, no root certificate and no publishable `dist/`. Running a release the way a collection does would fail while resolving the root certificate or while signing, and would produce nothing usable. The workflow therefore guards every publication-related step with a repository check: `if: github.repository != 'omds-chat/awesome-dsc-plugin-set-template'`.

| Step | Behaviour in the template repository | Guarded |
|:---:|:---:|:---:|
| Checkout, Setup pnpm, Setup Node.js, Install dependencies | Runs as usual | No |
| Import plugins | Runs as usual; the script returns 0 when the source manifest is empty | No |
| Resolve root CA | Skipped | Yes |
| Verify EEC against root CA | Skipped | Yes |
| Build distribution | Skipped | Yes |
| Verify distribution | Skipped | Yes |
| Configure Pages, Upload artifact | Skipped | Yes |
| The `deploy` job (Deploy to GitHub Pages) | The whole job is skipped | Yes |

- Skipping happens at step level rather than after a failure: a run in the template repository contains no action that needs the root certificate or the signing key, so it never fails for a missing secret.
- The check compares the full repository name. Once the skeleton is copied into a new repository, `github.repository` is that new name, the condition holds automatically, and build, signing and publishing proceed without editing the workflow.
- Renaming the organisation or the repository requires updating that literal, otherwise the template repository is treated as an ordinary collection and returns to a state where it always fails.
- The template repository also creates no `ci-memory` and holds no ledger: its workflow has no manifest read-back or write-back step, because that step exists only in a collection's pipeline, so there is nothing to skip here.

### Parallel branches

The three-layer manifests carry revisions across builds, so they live on a parallel branch that shares no ancestry with `main`. The branch name and its internal layout follow the organisation spec `.github/docs/repo-spec/side-branches.md`; the three parallel branches split the work as follows:

| Branch | Owning repository | Holds | In Pages | Readers |
|:---:|:---:|:---:|:---:|:---:|
| `ci-memory` | The consuming collection repository; the template does not create it | The three `manifest.json` and `manifest.json.sig` pairs mirrored under `layer-manifests/` along the distribution paths | No | The pipeline only |
| `certs` | `DeepSeek-Chat-Enhanced` | The root certificate and publicly shareable certificates and public keys | Yes | The web client and collections at runtime |
| `trusted-manifest` | `DeepSeek-Chat-Enhanced` | The trust list and the derived data its index needs | Yes | The web client and collections at startup |

- The consuming repository creates `ci-memory` itself with `git checkout --orphan ci-memory`, puts a single `README.md` that states its responsibility in the first commit, and checks it out as an independent worktree under `single-branch/ci-memory/`; `.gitignore` already ignores that directory.
- Inside the branch, flat folders are grouped by function and never nested further; only `layer-manifests/` exists here, mirroring each layer's manifest and signature along the distribution paths.
- The skeleton's `template/manifest.json` is the "empty baseline before the first build": `revision` is 1, it covers the four root files only and carries no history across builds; it is not a copy of the ledger, and `pnpm build` regenerates it from the content at hand.
- When a build cannot read that layer's manifest from `ci-memory`, revision counting starts at 1: the previous manifest in the working tree is the skeleton's empty baseline, so an unmodified copy keeps 1 and changed content moves to 2. The branch itself must already exist: a missing branch is a deployment error and the pipeline fails instead of creating it, and counting from 1 covers only a first build where the branch exists but `layer-manifests/` has no manifest for that layer yet. Once the ledger is in use, the main branch commits no further manifests.
- `ci-memory` is never published to Pages and is read and written by the pipeline only: the collection repository's pipeline restores the previous manifest from it and writes the current one back to it, and no client reads anything from it.
- The template repository does not create this branch and holds no ledger at all; it publishes the specification and the schemas only. When `ci-memory` is missing, the pipeline fails instead of creating it.
- The root certificate and the trust list are not in `ci-memory`: they come from the `certs` and `trusted-manifest` branches of `DeepSeek-Chat-Enhanced`, not from a branch of this repository. The three names never stand in for one another and never share a branch.

## Security notes

- Keep the root private key offline and use it only to issue EECs or generate a CRL. Keep the EEC private key and author keys in CI secrets and local environment variables. `.gitignore` already excludes `.env`.
- If the end-entity signing certificate is replaced or the private key leaks, ask the root CA to revoke it and issue a new one. Once `crl.pem` exists, verifiers add `--crl_check` and the revocation takes effect.
- Signatures cover file bytes. CMS signatures use `-binary` and author signatures use `-rawin`, so both are byte-exact: any change to line endings, indentation or whitespace breaks verification, and converting LF to CRLF fails as well. The repository uses LF everywhere.
- `build-collection.mjs --sign` first confirms that `EEC_SECRET_KEY` matches the committed end-entity signing certificate and fails otherwise, so it never produces signatures nobody can verify; it fails the same way while the certificate is still the placeholder file.
- Neither the placeholder file nor a test certificate may be committed or distributed: before a release, confirm that `certs/<collection id>/` holds the real end-entity signing certificate only and that no `_REPLACE_THIS_FILE_AS_YOUR_EEC_` is left behind.
- Never bypass a failed verification. The messages name the exact file and the reason.

## License

Apache License 2.0, see [LICENSE](LICENSE).
