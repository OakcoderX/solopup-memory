# SoloPup Memory 0.27.0-beta.1 开发候选

本候选新增原话回读和本轮回执。先用 `memory_search` 找到现行记忆的完整记录 ID，再用 `memory_source` 回查 DSH 原话。使用 `memory_receipt` 核对保存、请求和文件读回各自的状态。

This development candidate adds source readback and turn receipts. Search for the current memory by topic, then use its complete record ID to open the original source. The receipt records observations such as a successful write, a validated request, or a file check.

做梦默认关闭。重新打开更正提案时，`memory_dream_report` 可用预览 ID 核验记录与出处。报告和回执均为只读。macOS Super Agent 仍为实验功能。

[实施与验收](docs/runs/2026-11-25-0.27-development.md) · [变更记录 / Changelog](CHANGELOG.md) · [已发布稳定版](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0)
