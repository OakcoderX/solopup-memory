# SoloPup Memory — start here / 试用导航

SoloPup Memory 是 DeepSeek Harness 的公开测试版记忆插件，采用 MIT 许可。配置的模型服务可能计费。

## 0.26.0-beta.2 公开测试版 / Public beta

第七章用第二版，结尾照旧，改完附修改说明。继续同一工作区时，助手可以拿到少量与当前任务有关、有出处的现行约定。正文采用哪个版本和保留结尾这样的例外会一起呈现。在支持的 DSH 中，即使通过 shell 成功写入文件，也可以收到一次交付复核提示；只读命令不触发，出现提示也不等于交付已通过。 [安装](guides/quickstart.md) · [发行包与源码](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0-beta.2)

When you resume the same workspace, beta.2 can surface relevant source-linked decisions together with their conditions and exceptions. On supported DSH hosts, a successful shell write can prompt one handoff review. Read-only commands don't trigger it, and a reminder doesn't prove that the output meets the requirements. [Quick start](guides/quickstart.md) · [Release and source](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0-beta.2)

此前实测，不是本次发行包复验：按关闭插件 / 0.25.0-beta.2 / 0.26.0-beta.1 顺序，两道小任务按最新约定交付 **0/2、1/2、2/2**，主任务均 **2/2**。cattrs 单题本地官方规则严格分 **0/1、0/1、1/1**，两个开启组预装了相同的已核历史约定。独立中文续写 **0/4（超时）、3/4、3/4**；beta.1 漏验了文件最后一行。完整原生 Super Agent 链路仍待验证。 [历史评测与复现 / Historical beta.1 comparison](https://github.com/OakcoderX/solopup-memory/blob/v0.26.0-beta.1/docs/runs/2026-11-18-memory-delivery.md)

欢迎下载源码或 [Fork](https://github.com/OakcoderX/solopup-memory/fork)，附虚构用例、环境和实际交付的复现结果，一起改进 DSH 的记忆层。 Download or fork the source and share a fictional reproduction with the versions, steps and observed output.

## 第一次使用 / Getting started

第一次使用可以从快速上手开始，用一个虚构项目试试保存和回忆。想在 DSH 压缩聊天后核对作者原话，可开启做梦复核。长稿可以按采用版本和章节回查。 [交互演示](https://oakcoderx.github.io/solopup-memory/dreaming/) · [做梦设置](dream-review.md) · [0.25 验收](runs/2026-11-14-long-project-beta.md) · [0.24 做梦验收](runs/2026-11-13-dream-review-beta1.md)

下列案例提供操作步骤。历史离线样例的实际结果见其记录。 [离线来源回查记录](runs/2026-11-07-source-recall.md)

- [快速上手 / Quick start](guides/quickstart.md)
- [适合谁 / Who it is for](guides/who-its-for.md)
- [明确记住 / Explicit remember](guides/remember.md)
- [换聊天验收 / Fresh-chat recall](guides/fresh-chat.md)
- [Markdown 稿件回查](guides/markdown-reference.md)
- [项目与全局 / Project and global scope](guides/scope.md)
- [改主意 / Corrections](guides/corrections.md)
- [条件与例外 / Conditions and exceptions](guides/conditions.md)
- [事实与猜测 / Claims and guesses](guides/claims.md)
- [隐私与费用 / Privacy and cost](guides/privacy.md)
- [完整备份 / Complete backups](guides/backup.md)
- [装不上或没记住 / Troubleshooting](guides/troubleshooting.md)
- [测试版边界 / Beta limitations](guides/limits.md)
- [项目风格试用脚本](examples/project-style.md)
- [修订决定试用脚本](examples/revised-decision.md)
- [客户例外试用脚本](examples/client-exception.md)
- [双项目隔离试用脚本](examples/two-projects.md)
- [本人陈述与助手猜测试用脚本](examples/self-report.md)
- [检索表达差异试用脚本](examples/lexical-recall.md)
- [贡献指南](../CONTRIBUTING.md)
- [可复现问题反馈模板](../.github/ISSUE_TEMPLATE/bug_report.md)
- [语义误记反馈模板](../.github/ISSUE_TEMPLATE/semantic_report.md)
- [平台试用反馈模板](../.github/ISSUE_TEMPLATE/platform_report.md)
- [贡献PR模板](../.github/PULL_REQUEST_TEMPLATE.md)
- [测试者反馈入口](feedback.md)
- [双语媒体资料包](press-kit.md)
- [双语FAQ](faq.md)
- [公开测试参与说明](beta-trial.md)
- [双语术语表](glossary.md)
- [安装方式选择页](install-options.md)

[Source repository](https://github.com/OakcoderX/solopup-memory) · [npm](https://www.npmjs.com/package/solopup-memory) · [Release evidence](../RELEASE.md)
