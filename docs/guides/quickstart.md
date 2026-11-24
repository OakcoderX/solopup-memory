# 快速上手 / Quick start

先确认正在使用 DeepSeek Harness（DSH），Node >=24.9，DSH >=0.2.1-rc.0 且 <0.3.0。当前本地验证环境为 macOS。

**当前稳定版是 0.26.0。** 安装这一版请使用明确版本号。需要离线安装或复验时，可以下载同一发行页中的 `solopup-memory-0.26.0.tgz` 和 `SHA256SUMS`。 [下载发布包和校验文件](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0)

```sh
dsh plugin --profile desktop add solopup-memory@0.26.0 --ignore-scripts
```

也可在下载目录校验后安装发布包。

```sh
shasum -a 256 -c SHA256SUMS &&
  dsh plugin --profile desktop add "$PWD/solopup-memory-0.26.0.tgz" --offline --ignore-scripts
```

npm 的 `latest` 随稳定版更新。新版发布当天，使用 pnpm 11 的 DSH 安装器对浮动标签可能暂时选择较早版本。用 `memory_status` 核对实际加载版本。 [pnpm 的新包观察期](https://pnpm.io/blog/releases/11.0#security--build-defaults)

```sh
dsh plugin --profile desktop add solopup-memory@latest --ignore-scripts
```

Pin `0.26.0` to install this exact stable release immediately, or install the checked archive offline. The npm `latest` tag tracks the stable release. DSH installations using pnpm 11 may still resolve an earlier version during the new package's first day. Use `memory_status` to check the version you actually loaded.

重启对应 profile，运行 `memory_status`，核对已加载的版本。新会话说「记住：本项目使用两空格缩进」，等记忆写入后，再开新会话询问此约定。

在 DSH 里养大肥鱼？用[换会话与改口自测](dsh-fish-memory.md)检查新称呼、原话来源和项目边界。

从旧版本升级时，先[完成备份](backup.md)，再退出正在使用的 DSH profile，运行 `dsh plugin --profile desktop remove solopup-memory`，再运行上面的安装命令。此前的 0.25 → 0.26 → 0.25 隔离回退测试验证了同一份已有记忆在该过程中保留，并在每次启动时重新读到。Web 用户把 `desktop` 换成实际 profile。

Restart the same profile, check the loaded version with `memory_status`, then test an explicit remember request and recall it in a fresh conversation. [0.26.0 旧库升级、回退与复核验收 / Acceptance and scope](../runs/2026-11-24-stable-desktop.md)

For an existing install, [back up your data](backup.md), stop the profile, remove `solopup-memory` from it, and install the stable release above. In the earlier 0.25 → 0.26 → 0.25 isolated upgrade and rollback test, the same memory files were retained and read after each restart.

Idle review is optional. Select your project and model, leave DSH running, then open the latest dream report in that project's session. Check the source and use the regular memory write flow to adopt any correction. Ordinary DSH can run the review on its own. Super Agent mode remains experimental. [Idle review setup](../dream-review.md) · [Test results and limits](../runs/2026-11-13-dream-review-beta1.md)

[安装与限制](../../README.md) · [English](../../README.en.md) · [试用导航](../README.md)
