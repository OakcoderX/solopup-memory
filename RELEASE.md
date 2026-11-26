# SoloPup Memory 0.27.0

在受支持的 DSH 宿主上回查记忆对应的原始消息，并通过本轮回执查看记忆保存、模型请求和文件核对情况。

Dream 和自动应用均需主动开启。自动应用仅处理符合严格格式、来源和项目条件的单值明确更正，范围限于受支持的交付语言、交付格式和交付模板版本；其他情况留待复核。报告区分已应用与仅供复核；撤回预览为只读，执行前需核对完整影响范围。[设置与撤回](docs/dream-review.md)

0.27 的 Dream 队列为 v5，0.26 无法打开。回退前关闭所有写入进程和相关 profile 的 Dream，备份完整 Dream 目录，并按[离线停放与重新挂回说明](docs/dream-rollback.md)操作。Super Agent 仍为实验功能。

[0.27 开发记录](docs/runs/2026-11-25-0.27-development.md)和 [beta.2 对照](docs/runs/2026-11-25-dream-auto.md)只对应各自的测试版本；本稳定包的实际桌面验收记录见正式发行页所附的 [desktop-acceptance.json](https://github.com/OakcoderX/solopup-memory/releases/download/v0.27.0/desktop-acceptance.json)。[完整变更](CHANGELOG.md)
