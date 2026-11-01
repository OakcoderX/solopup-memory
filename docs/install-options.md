# Installation choices / 安装方式

Install the pinned GitHub privacy update. npm beta.3 may follow later; check the registry and release notes before selecting npm:

```sh
dsh plugin --profile desktop add github:OakcoderX/solopup-memory#v0.21.0-beta.3 --ignore-scripts
```

`solopup-memory@beta` follows the beta tag and can change. The GitHub release also supplies a local archive; install it with the official manager using its absolute path and `--offline --ignore-scripts`. See the root README for the full command and upgrade precautions.

Custom plugin markets users can add `https://raw.githubusercontent.com/OakcoderX/solopup-memory/main/market/index.json` in Discover → Add index source after enabling the experimental feature. This is a self-hosted source, not an official endorsement.

重启同一 profile 并核对 memory_status。卸载保留数据；从旧名 dsh-memory 迁移时先完整备份、关闭宿主、移除旧包，避免两个插件同时启用。

[Quick start](guides/quickstart.md) · [Compatibility](../COMPATIBILITY.md)
