# 0.26.0 核心文字记忆验收 / Core text-memory acceptance

**升级后，Flash 在新会话里按更正后的规则交出主稿，审读稿保留了原来的例外。** 旧版所写的有效记忆和来源在升级后还能查回。恢复升级前的备份后，旧版能重新读取原库。

这次验收使用真实的 DeepSeek Flash、合成资料和本机模拟写工具。从 npm 原包 `0.21.0-beta.1` 开始，在官方 DSH `0.2.1-rc.5` 写入旧资料，再用签名 macOS DSH `0.2.2-rc.3` 的 CLI 及隔离 profile 加载最终 `0.26.0`。223 个安装后文件与归档逐字节一致。Flash 关闭思考，22 次请求共 45,104 token，含 33,024 个缓存读取 token。

| 核查项 | 实测 |
|---|---|
| 带库升级与回退 | 原有规则、例外和来源可读。回退恢复升级前的备份，另存升级后产生的数据。 |
| 新会话按现行规则交付 | 主稿文件实际写入新值，审读稿写入保留的旧例外，均已读回。 |
| 撤回与工作区 | 撤回项在后续现行记忆里缺席，新工作区没有复用另一项目的规则。 |
| 交付复核 | 两个文件写入、两个成功模拟写入分别触发一次复核。纯聊天、只读和失败模拟写入均为零。两个成功模拟动作各发生一次实际变更。 |

早期 RC 的复核提示曾导致 Flash 重复调用已成功的模拟外部写入。更正后的提示要求核对已有结果或只读状态。预检还发现了模拟工具的空状态返回错误。修正模拟工具后，正式归档独立重跑七项，均通过。

覆盖范围是指定 macOS 宿主、模型与合成案例。同一归档在官方 DSH `0.2.2-rc.5` CLI 通过零模型调用的长历史检查。Dream Review 默认关闭，Super Agent 仍为实验功能。历史 FrontierMemory 成绩属于对应实验版本。 [完整机器回执](../../release-evidence/0.26.0.json) · [安装与回退](../guides/quickstart.md)

**上架后复验。** 从 npm 显式安装 `solopup-memory@0.26.0`，可读回版本并加载 `memory_status` 和 `memory_search`，安装的 223 个文件再次与归档一致。npm `latest` 已指向 0.26.0。发布当天，两次全新 DSH 安装用裸包名或浮动标签都解析到 beta.3，符合内置 pnpm 的新包观察期。安装指南因此将精确稳定版放在首位。 [固定版本回执](../../release-evidence/0.26.0-public-install.json) · [浮动安装回执](../../release-evidence/0.26.0-floating-install.json)

## English

**After the upgrade, Flash followed the corrected project rule in a fresh session and retained the exception in a separate review draft.** We read both files back. The old memory and its source references remained readable, and restoring the pre-upgrade backup allowed the original version to read the old store again.

We seeded the store with the published npm package `0.21.0-beta.1` on official DSH `0.2.1-rc.5`, then used the signed macOS DSH `0.2.2-rc.3` CLI in an isolated profile. All 223 installed files matched the final archive. Real Flash with reasoning disabled made 22 requests and used 45,104 tokens, including 33,024 cached input tokens.

Each successful file or simulated tool write triggered one review. Chat, read-only operations, and failed writes triggered none. The two successful simulated actions each mutated state once. An early candidate caused Flash to repeat an external write during review. The revised cue asks the model to inspect the existing result or use a read-only lookup.

During preflight, a simulated lookup returned a filesystem error for an empty record. We corrected the simulator, then ran all seven cases on the final archive. The attached receipt covers that final run. This acceptance covers the named host, model and synthetic tasks. The same archive passed the long-history checks on the official DSH `0.2.2-rc.5` CLI without model calls. Dream Review is opt-in. The Super Agent companion remains experimental. [Machine-readable receipt](../../release-evidence/0.26.0.json)

**Public installation check.** Installing `solopup-memory@0.26.0` from npm loaded both memory tools, and the 223 installed files matched the release archive. The npm `latest` tag pointed to 0.26.0. Two clean, unpinned installs resolved to beta.3 during the package-age window, so the DSH guide leads with the verified exact version. [Pinned installation receipt](../../release-evidence/0.26.0-public-install.json) · [Floating installation receipt](../../release-evidence/0.26.0-floating-install.json)
