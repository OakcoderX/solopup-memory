# 原话来源离线运行记录 / Offline source-recall receipt

这是实际执行的**确定性机制演示**，输入为虚构项目约定，审查回复由测试桩固定批准。它不是用户证言、真实模型结果或实际 DSH 宿主验收。

## 环境与复现

- 执行时间（UTC）：`2026-11-07T11:00:13.635Z`
- 环境：Linux x64，Node `v24.22.1`
- 源码声明版本：`0.21.0-beta.4`。本次文档和目录修正没有发布新的 npm 版本。
- 运行时基线：`2bdcc7a451df1b7519674997ba9975ef6ca3e435`；本次没有修改运行时模块。
- [演示脚本](../../scripts/demo-source-recall.mjs) SHA-256：`9d666a62c85363172e71a6d196d35fb2e1d52c715b8fb653777294885a057326`
- [完整 JSON 工具结果](2026-11-07-source-recall.json)。其中的临时路径、哈希和时间来自本次执行，重跑会变化。

在源码目录运行，不需要 DSH 安装、账户、网络或付费模型：

```sh
node scripts/demo-source-recall.mjs
node scripts/demo-source-recall.mjs --json
```

每次运行创建临时 `DSH_HOME` 和两个带 `.dsh-root` 标记的虚构项目，结束后清理。子进程环境采用现有探针白名单，不继承父进程账户、凭据或 `NODE_OPTIONS`。不会读取或写入真实记忆库。

## 实际输出摘要

```text
synthetic user: 记住：本项目的交付说明统一用中文。
memory_write: recorded (scope=project, meaning=decision)
fresh process / memory_search("交付说明"): 1 hit (scope=project)
current text: - [project] 本项目的交付说明统一用中文 — 索引摘要
history source: synthetic-demo-write:1; quote: 记住：本项目的交付说明统一用中文。
other project / current + history: 0 + 0 hits
```

1. 写入进程向脚本化宿主提交虚构用户消息和 `memory_write` 调用事件，执行生产工具处理函数。原有来源、范围和格式检查仍然执行；仅模型审查回复是固定的 `supported` 测试桩。实际结果为 `recorded`。
2. 写入进程退出后，同项目的新 Node 进程使用新 session ID，不重放旧消息，调用生产 `memory_search`。当前视图命中项目摘要；显式 `view: "history"` 的另一次调用返回原话，以及 `sourceSessionId` 和 `sourceMessageIds`。
3. 另一项目再开新 Node 进程，当前与历史视图均为零命中。这只证明本次虚构条目的项目过滤，不能把一般空结果当成记忆从未存在。
4. 脚本对写入状态、命中数、项目归属、逐字原话和消息来源做断言。执行失败时以非零退出码结束，不输出成功摘要。

## 没有验证什么

- 没有启动官方 DSH 宿主，因此不验证其 schema 注册、安装或升级流程。
- 没有调用真实模型。虚构用户消息由脚本注入，写入候选与审查通过结果均预先给定，不验证模型是否主动调用工具、概括是否准确或审查是否可靠。
- 新进程只能证明本次数据落盘后可被无旧消息的工具调用找回，不等同于自然语言新聊天回答正确。
- 未测自动捕获、长期使用、多平台结果、跨语言召回或隐私分类覆盖；也不改变公开测试版状态。

真实模型和宿主的后续验收请按[换聊天验收](../guides/fresh-chat.md)执行，并把实际结果与本记录分开。

## English summary

Measured offline mechanics run with synthetic data, production tool handlers and a scripted host/validator. Three separate Node processes exercise write, same-project recall and other-project filtering. The reader processes receive no old conversation. Current search returns the effective summary; an explicit history query returns the original quote and source identity. This does not test real DSH registration, real-model decisions, natural-dialogue fresh-chat recall or sustained reliability. The full JSON receipt above preserves the actual tool results.
