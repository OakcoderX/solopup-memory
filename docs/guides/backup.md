# 完整备份 / Complete backups

仅复制 Markdown 不足以完整备份：来源、候选、历史账本和独立控制库也属于系统状态。

先关闭所有使用该库的宿主与写入器。按 README 的 backup.mjs create 和 verify 生成并验证新快照。恢复先预览，再核对目标、review 与哈希；不要删除控制文件绕过屏障。

Stop all writers, create a full snapshot with the supplied backup script, and verify it. Restore is reviewed and preserves withdrawal controls; consult the root README for exact commands.

公开测试版 / Public beta 0.22.0-beta.3.

[安装与限制](../../README.md) · [English](../../README.en.md) · [试用导航](../README.md)
