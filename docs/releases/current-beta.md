# 当前公开测试版 / Current public beta

**0.24.0-beta.2** · Public beta, not a stable release or official endorsement.

## 固定版本安装 / Reproducible install

```sh
dsh plugin --profile desktop add solopup-memory@0.24.0-beta.2 --ignore-scripts
```

For the moving beta channel use `solopup-memory@beta`. A bare `solopup-memory`
uses npm's separate `latest` tag, not necessarily this beta. Existing installations
are not automatically upgraded. Restart the selected profile and check `memory_status`.

- [Release and acceptance notes](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.24.0-beta.2)
- [Prebuilt archive](https://github.com/OakcoderX/solopup-memory/releases/download/v0.24.0-beta.2/solopup-memory-0.24.0-beta.2.tgz)
- [Manifest](https://github.com/OakcoderX/solopup-memory/releases/download/v0.24.0-beta.2/manifest.json) · [Publication receipt](https://github.com/OakcoderX/solopup-memory/releases/download/v0.24.0-beta.2/npm-receipt.json)
- Source tag commit: `4f34af75fa3f0bf6e8b8cd76150ee786ed4bcd35`
- Archive SHA256 reported by the [GitHub release API](https://api.github.com/repos/OakcoderX/solopup-memory/releases/tags/v0.24.0-beta.2): `869c0d879a738056c5cd8557ed7e54e69950b781124d1ba2301a12942211499f`

This initial entry records the existing published release and its reported digest.
The documentation edit did not independently download and reverify the release
receipt or tarball. Future successful releases regenerate this page from the
publication workflow's verified public-download receipt, including npm integrity.
The source tag and release metadata above were checked on 2026-11-14.

Declared engine ranges do not prove every host version was tested. Consult the
linked release evidence for actual host checks, model experiments and their
limitations. Automated synchronization verifies publication identity, not memory
quality, security certification, third-party approval or real adoption.
