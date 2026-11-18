# 快速上手 / Quick start

先确认正在使用 DeepSeek Harness（DSH），Node >=24.9，DSH >=0.2.1-rc.0 且 <0.3.0。当前本地验证环境为 macOS。

```sh
dsh plugin --profile desktop add solopup-memory@0.26.0-beta.1 --ignore-scripts
```

重启对应 profile，运行 `memory_status`，核对版本。新会话说「记住：本项目使用两空格缩进」，等记忆写入后，再开新会话询问此约定。

从旧版本升级时，先退出正在使用的 DSH profile，运行 `dsh plugin --profile desktop remove solopup-memory`，再运行上面的安装命令。隔离回退测试验证了同一份已有记忆在 0.25 → 0.26 → 0.25 过程中保留，并在每次启动时重新读到。Web 用户把 `desktop` 换成实际 profile。

Restart the same profile, check the loaded version with `memory_status`, then test an explicit remember request and recall it in a fresh conversation.

For an existing install, stop the profile, remove `solopup-memory` from that profile, then install the pinned version above. In the isolated upgrade and rollback test, the same memory files were retained and read after each restart.

Idle review is optional. Select your project and model, leave DSH running, then open the latest dream report in that project's session. Check the source and use the regular memory write flow to adopt any correction. Ordinary DSH can run the review on its own. Super Agent mode uses a tested prototype setup. [Idle review setup](../dream-review.md) · [Test results and limits](../runs/2026-11-13-dream-review-beta1.md)

[安装与限制](../../README.md) · [English](../../README.en.md) · [试用导航](../README.md)
