# SoloPup 0.26 文字记忆评测 · Text memory evaluation

**同一套 DSH 和 Flash，带记忆完整通过 3/12，关闭记忆通过 1/12。** 新增通过的是 Teams 和 Word2Vec。CSM 两组都通过。带记忆的 9 个零分保留在下表。

**With the same DSH host and Flash model, the memory arm fully passed 3 of 12 tasks, compared with 1 of 12 without memory.** The two additional passes were Teams and Word2Vec. Both arms passed CSM. The table includes all nine zero scores in the memory arm.

| 官方原题 / Original task | 关闭 / Off | SoloPup |
| --- | ---: | ---: |
| Awilix Release Tier (Explicit) | 0 | 0 |
| Awilix Release Tier (Implicit) | 0 | 0 |
| cattrs Partial Structuring | 0 | 0 |
| Content Inventory Recommendations | 0 | 0 |
| Customer Delivery Conventions | 0 | 0 |
| Customer Support Contract Update (CSM) | 1 | 1 |
| HTTPX CookieStore | 0 | 0 |
| Network Intrusion Analysis (DAPT) | 0 | 0 |
| Partnership Contract | 0 | 0 |
| Stakeholder Proposal Strategy | 0 | 0 |
| Teams Channel & Call Setup | 0 | 1 |
| Word2Vec Pipeline | 0 | 1 |
| **完整通过数 / Full passes** | **1/12** | **3/12** |

## 测试范围

12 道非 APEX 原题，每题每组一次。两组均使用 DSH 0.2.2-rc.3、DeepSeek V4.1 Flash（关闭推理档）和原题验证器。两组都要求核对实际交付值。带记忆组加载 SoloPup 0.26 冻结实验包。同一任务验证器裁定是否完整通过，未计入三个 APEX 试次。单题没有重复作答，不能据此估计跨次波动。

Teams 的通过说明历史工具参数能帮助完成真实操作。失分也有不同成因。例如带记忆的内容盘点满足了 10/13 项，销售提案满足了 8/10 项，严格分均为 0。此前单独开展的 cattrs 诊断试验使用了不同的运行配置，因此这里照录该冻结批次的 0 分。成绩来自冻结实验包，SHA-256 为 `25503f90ebdb165905624a845daa44b696ccb93b240ba4611eddb14431dde797`。公开发布包另行通过了 Mac 上的真实 DSH 宿主验收，覆盖两个跨会话工作区及八个长文本场景，使用合成资料和脚本响应。此表是原题本地对照，官方榜单使用不同的下游运行条件。

## Scope

Each arm attempted each of the 12 original non-APEX tasks once. Both used DSH 0.2.2-rc.3, DeepSeek V4.1 Flash with thinking disabled, the original task verifiers, and the same instruction to check the values actually delivered. The three APEX tasks are outside this comparison. A task counted only if it passed in full.

Teams shows how past tool parameters can help an agent carry out an action. Other tasks differed in where they fell short. With memory, Content Inventory met 10 of 13 checks and Stakeholder Proposal met 8 of 10, yielding zero on both under strict scoring. A separate cattrs diagnostic used different run settings. The scores here belong to the frozen experimental package with the SHA-256 shown above. The public release package also passed a separate acceptance check on the installed Mac DSH host, covering two cross-session workspaces and eight long-text cases with synthetic data and scripted responses. These are local runs of the original tasks. The public leaderboard uses different downstream settings.

[官方题目 / Official tasks](https://frontiermemory.com/tasks/) · [官方规则 / Official protocol](https://github.com/letta-ai/frontiermemory/blob/main/docs/rules.md)
