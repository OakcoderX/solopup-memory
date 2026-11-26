# Installation choices / 安装方式

桌面用户优先打开[稳定版安装指南](guides/quickstart.md)。指南提供当前 0.27.0 发布包、校验文件和安装命令。 The guide links to the current stable archive and explains how to verify it before installation.

```sh
dsh plugin --profile desktop add solopup-memory@0.27.0 --ignore-scripts
```

The npm `latest` channel tracks stable. A DSH installer using pnpm 11 can still resolve an older version on release day. Verify and use the [0.27.0 GitHub release archive](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.27.0) for an exact installation. Choose `@next` or `@beta` only to try a prerelease.

Custom plugin markets users can add `https://raw.githubusercontent.com/OakcoderX/solopup-memory/main/market/index.json` in Discover → Add index source after enabling the experimental feature. This is a self-hosted source, not an official endorsement.

重启同一 profile 并核对 memory_status。卸载保留数据；从旧名 dsh-memory 迁移时先完整备份、关闭宿主、移除旧包，避免两个插件同时启用。

[Quick start](guides/quickstart.md) · [Compatibility](../COMPATIBILITY.md) · [Optional idle review](dream-review.md) · [Test results and limits](runs/2026-11-13-dream-review-beta1.md)
