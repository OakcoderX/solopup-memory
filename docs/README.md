# SoloPup Memory — start here / 试用导航

SoloPup Memory 是 DeepSeek Harness 的文字记忆插件，采用 MIT 许可。配置的模型服务可能计费。

## 0.26.0 稳定版 / Stable release

0.26.0 延续了 beta.6 的同工作区原话找回，并在受支持的文件写入与 MCP 写操作后提示交付复核。历史跑分的更正和边界见 [更新日志](../CHANGELOG.md)。

第七章用第二版，结尾照旧，修改说明另附。继续同一工作区时，助手可以拿到少量有出处的现行约定。在普通 DSH 会话明确选稿后，插件可以据此判断条件约定是否适用。只读核验工具能读取指定项目 Markdown 稿件末行，给出是否符合已保存的约定及所检查文件的 SHA-256。它不会改稿，也不评判全文；编辑后收到复核提示不等于交付已通过。 [安装](guides/quickstart.md) · [发行包与源码](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0)

When you resume a workspace, the plugin can surface a small set of relevant, source-linked agreements. An explicit manuscript selection can resolve a conditional agreement in a normal DSH turn. A read-only tool can check the named project Markdown file's last line against a saved agreement and identify the inspected revision by SHA-256. It neither edits the file nor grades the whole manuscript. [Quick start](guides/quickstart.md) · [Release and source](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0)

历史归档曾在同一台 Mac 的 DSH 0.2.2-rc.3 上，用固定模型响应检查六项选稿与文件核验。归档所测插件包的 SHA-256 与公开 beta.3 下载附件不同，不能把历史结果直接归给公开包；该公开包的同流程复跑尚未完成。脚本固定响应也不代表模型自主写作或完整原生 Super Agent 实测。 [历史试验与边界 / Historical protocol and scope](https://github.com/OakcoderX/solopup-memory/blob/v0.26.0-beta.3/docs/runs/2026-11-22-manuscript-delivery.md)

此前实测，不是本次发行包复验：按关闭插件 / 0.25.0-beta.2 / 0.26.0-beta.1 顺序，两道小任务按最新约定交付 **0/2、1/2、2/2**，主任务均 **2/2**。cattrs 单题本地官方规则严格分 **0/1、0/1、1/1**，两个开启组预装了相同的已核历史约定。独立中文续写 **0/4（超时）、3/4、3/4**；beta.1 漏验了文件最后一行。这轮没有验证完整原生 Super Agent 链路。 [历史评测与复现 / Historical beta.1 comparison](https://github.com/OakcoderX/solopup-memory/blob/v0.26.0-beta.1/docs/runs/2026-11-18-memory-delivery.md)

欢迎下载源码或 [Fork](https://github.com/OakcoderX/solopup-memory/fork)，附虚构用例、环境和实际交付的复现结果，一起改进 DSH 的记忆层。 Download or fork the source and share a fictional reproduction with the versions, steps and observed output.

## 第一次使用 / Getting started

第一次使用可以从快速上手开始，用一个虚构项目试试保存和回忆。想在 DSH 压缩聊天后核对作者原话，可开启做梦复核。长稿可以按采用版本和章节回查。 [交互演示](https://oakcoderx.github.io/solopup-memory/dreaming/) · [做梦设置](dream-review.md) · [0.25 验收](runs/2026-11-14-long-project-beta.md) · [0.24 做梦验收](runs/2026-11-13-dream-review-beta1.md)

下列案例提供操作步骤。历史离线样例的实际结果见其记录。 [离线来源回查记录](runs/2026-11-07-source-recall.md)

- [快速上手 / Quick start](guides/quickstart.md)
- [DSH 养鱼教程：大肥鱼换会话如何保留长期记忆](guides/dsh-fish-memory.md)
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
- [当前能力与限制 / Capabilities and limitations](guides/limits.md)
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
- [预览版参与说明](beta-trial.md)
- [双语术语表](glossary.md)
- [安装方式选择页](install-options.md)

[Source repository](https://github.com/OakcoderX/solopup-memory) · [npm](https://www.npmjs.com/package/solopup-memory) · [Release evidence](../RELEASE.md)
