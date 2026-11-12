# 快速上手 / Quick start

先确认正在使用 DeepSeek Harness（DSH），Node >=24.9，DSH >=0.2.1-rc.0 且 <0.3.0。当前本地验证环境为 macOS。

```sh
dsh plugin --profile desktop add solopup-memory@0.24.0-beta.2 --ignore-scripts
```

重启对应 profile，运行 `memory_status`，核对版本。新会话说「记住：本项目使用两空格缩进」，等记忆写入后，再开新会话询问此约定。

Restart the same profile, check the loaded version with `memory_status`, then test an explicit remember request and recall it in a fresh conversation.

Idle review is optional. Select your project and model, leave DSH running, then open the latest dream report in that project's session. Check the source and use the regular memory write flow to adopt any correction. Ordinary DSH can run the review on its own. Super Agent mode uses a tested prototype setup. [Idle review setup](../dream-review.md) · [Test results and limits](../runs/2026-11-13-dream-review-beta1.md)

[安装与限制](../../README.md) · [English](../../README.en.md) · [试用导航](../README.md)
