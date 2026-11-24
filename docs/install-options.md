# Installation choices / 安装方式

Use the stable release from npm for the desktop profile. 桌面 profile 默认推荐稳定版。

```sh
dsh plugin --profile desktop add solopup-memory@latest --ignore-scripts
```

Pin `solopup-memory@0.26.0` for a reproducible installation. Choose `@next` or `@beta` only to try a prerelease. The [0.26.0 GitHub release](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0) supplies the archive and checksum. Install it with the official manager using its absolute path and `--offline --ignore-scripts`. See the root README for the full command and upgrade precautions.

Custom plugin markets users can add `https://raw.githubusercontent.com/OakcoderX/solopup-memory/main/market/index.json` in Discover → Add index source after enabling the experimental feature. This is a self-hosted source, not an official endorsement.

重启同一 profile 并核对 memory_status。卸载保留数据；从旧名 dsh-memory 迁移时先完整备份、关闭宿主、移除旧包，避免两个插件同时启用。

[Quick start](guides/quickstart.md) · [Compatibility](../COMPATIBILITY.md) · [Optional idle review](dream-review.md) · [Test results and limits](runs/2026-11-13-dream-review-beta1.md)
