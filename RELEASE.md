# SoloPup Memory 0.27.0-beta.2

**做梦可以让明确的项目更正在下一个会话里自动生效。** 为选定项目开启自动应用后，SoloPup 在 DSH 闲置时核对更正原话。能准确定位的一项值会更新，原有条件、例外和历史会保留。做梦报告会留下来源和应用结果。

在原生 macOS DSH `0.2.2-rc.3` 上，我们用同一个 DeepSeek Flash、同一份旧记忆和同一句更正做了配对。重启后，只出报告组仍用中文交付，自动应用组改用英文。两组都保留内部批注用中文。后台用量分别为 600 和 605 token。随后撤回更正来源，英文规则退出了现行记忆。

**Explicit project corrections can carry over automatically.** With automatic application enabled, SoloPup checks the original message during idle time, applies a supported change to one value, and keeps existing conditions, exceptions and history. In an isolated desktop test, a fresh session switched the delivery language to English and kept Chinese for internal notes. The report-only session kept both in Chinese.

- **查原话和本轮回执。** `memory_source` 回查原始 DSH 消息，`memory_receipt` 分别显示记忆保存、模型请求核对和文件检查的情况。
- **区分试案和定案。** 自动采集保留试行状态，闲时整理可折叠完全相同的索引行，同时保留原记录。

做梦和自动应用均需主动开启。本次真机效果覆盖一个单人文字项目。Super Agent 仍为实验功能，标准原型的恢复问题已提交 DSH 官方。默认安装继续指向 `0.26.0`。 [设置与撤回](docs/dream-review.md) · [实测方法和限制](docs/runs/2026-11-25-dream-auto.md) · [完整变更](CHANGELOG.md) · [DSH 反馈](https://github.com/deepseek-ai/deepseek-harness/discussions/14293) · [稳定版](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0)
