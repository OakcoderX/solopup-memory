# 做梦（DREAMING）设计草案

> 下一功能：在夜间/低调用时段，由本地插件自己整理记忆。
> 本文先给外部事实（谁真的做了、证据多强），再给可落地的设计。
> **P0 影子报告 + P1 安全应用已实现**（`scripts/dream.mjs`）：P1 只自动执行 `compact-index`（复用 `pruneStore`），要求 `--reviewed <planHash>`、先备份、应用后 L0 复核；其余 op 明确留给人工。

## 0. 结论先行

- **Anthropic 已经在 2026-11-06 公开了 “dreaming”**：四层记忆
  transcripts → memory notes → wiki 表征 → 注入上下文，dreaming 在空闲期做三件事：
  用 transcript 校对笔记、建/并 wiki、把笔记上提到注入层。
  同机制已产品化为 Managed Agents 的 **Dreams API**：异步 job，输入 = 1 个已有 store + 1–100 个 session，
  **输出新 store、输入永不修改**，可 cancel，失败保留部分产出。
- **OpenAI Codex 没有 “dreaming” 这个词**，但官方文档确认了后台整合的调度哲学：
  等会话 idle 足够久、跳过活跃/短会话、剩余 rate-limit 低于阈值就跳过这一轮；
  第三方源码分析（非官方）显示两阶段抽取/合并、owner token + lease、watermark、按 thread 差量遗忘。
- **Claude Code 本身不做睡眠整合**：auto memory 只在会话内写，MEMORY.md 只注入前 200 行/25KB。
- 对 SoloPup 的结论：**不要做“全库重写式做梦”**。应做“事件驱动 + 水位 + 三档输入 + shadow 库 diff
  + 人工确认”的小步整理；所有操作走 op 账本，天然可 diff、可撤回、可崩溃恢复。
  这是 SoloPup 相对 Anthropic“整库克隆”的结构优势，代价是必须做 op 级幂等。

## 1. 外部事实（2026-11-08 访问）

| 来源 | 关键事实 | 证据强度 |
|---|---|---|
| Anthropic《The components of agent memory》（2026-11-06） | dreaming 定义为空闲期用 transcript 校对笔记、构建/合并 wiki、把笔记上提到注入层；四层结构 | 官方研究文 |
| Anthropic Dreams API（Managed Agents，research preview） | 异步 job；输入 store + sessions；**输出新 store，输入永不修改**；状态机 pending/running/completed/failed/canceled；`instructions` 只能做高层综合；按时长线性计费 | 官方文档 |
| Claude Code memory 文档 | auto memory 会话内联写；无睡眠整合；注入前 200 行/25KB | 官方文档 |
| Codex memories 文档 | 后台更新；等 idle；跳过活跃/短会话；rate-limit 低于阈值跳过 pass；可配 extract/consolidation 双模型 | 官方文档 |
| Codex 源码分析（第三方） | 两阶段抽取/合并、SQLite owner token + 1h lease + 90s 心跳、watermark、selection diff + usage_count、按 thread 差量遗忘；无向量 | 第三方，非官方 |
| Letta sleep-time compute（arXiv 2504.13171） | 离线预计算可预测查询；同等准确率测试算力降约 5×，准确率 +13%/+18%；强依赖查询可预测性 | 论文 |
| A-MEM（arXiv 2502.12110） | 原子笔记 + LLM 建链 + 记忆演化（新记忆改写旧笔记）；风险是静默改写与幻觉建链 | 论文 |
| MemoryOS（arXiv 2506.06326） | 分层记忆 + 热度/时间驱动更新与淘汰 | 论文 |
| Generative Agents（arXiv 2304.03442） | memory stream + 反思：重要度累积过阈值生成高层反思写回 | 论文 |
| Google Sleep framework（博客） | 把“睡眠期”引入持续学习 | 官方博客，非论文 |

**注意**：Anthropic 和 OpenAI 都没有“夜间自动做梦”的官方调度文档；Dreams 由调用方触发。
“晚上自己做梦”是我们自己的调度设计，不是照抄。

## 2. Anthropic 公布的反面数据（最值得抄的部分）

这些数字比“能力宣称”有用，因为它们定义了失败模式：

| 现象 | 数据 |
|---|---|
| 记忆文件越多 ≠ 越好 | 宝可梦约 1 万步：9 个文件拿 4 徽章；413 个文件只拿 1 徽章 |
| 纠错有效 | 记错 PokéCenter 方位，dreaming 对照 transcript 改回后 1935 步抵达新城；未纠错版 3 次掉崖后放弃 |
| 规模收益 | 35 万文档、128 次 dreaming：25 题达标率 13% → 48%；wiki+search 54% → 61%，每问省约 2 万 token |
| 表征膨胀 | 一次 wiki 膨胀到语料 **1.77 倍**（抽象为零） |
| 并发覆写丢内容 | 多 agent 同写一页，57 条要点只剩 41 条（72%） |
| 官方自述 | “全量校验不划算，频率应按易变程度/访问频率调” |

三条直接约束：
1. **整理必须可验证**：每次 dream 的产出要和输入 diff，不能静默替换。
2. **禁止无证据改写**：每条 op 必须能指回原话 / 原记录 id，否则不写。
3. **频率按易变程度**：高频变动的条目多查，冷条目抽查；不是每晚全库。

## 3. SoloPup 做梦的定位

现有架构里，dream 是**第二个消费者**，不是新的事实来源：

```
对话事件 → 自动捕获（抽取 + 审查）→ 候选账本 → 有效记忆 → 索引注入 / 检索
                                   ↘
                              dream（只读账本 + 索引 + 主题文件）
                                   ↘ op 计划 → shadow 目录 → diff → 人工确认 → 原子应用
```

- 复用：`candidates.mjs`（候选状态机）、`episodes.mjs`（历史）、`withdrawal.mjs`（撤回）、
  `detect.mjs`（L0 不变量）、`pruneStoreLocal`（确定性压缩）、`publication.mjs`（原子发布）。
- 不新增：向量库、图数据库、云服务、常驻定时器、第二个事实库。

## 4. 调度：事件驱动 + AND 门

不要 `setInterval` 常驻。在 `session/disposed`、`step/end` 或插件启动时做一次“是否该 dream”的判定，
满足全部条件才启动；启动后立刻写租约，防止多宿主同时做梦。

| 门 | 条件 | 理由 |
|---|---|---|
| G1 变更水位 | 自上次 dream 后新增 capture ≥ N（默认 10）或距上次 ≥ 12h | 没新东西不整理 |
| G2 静默 | 最近会话静默 ≥ 20min（本地时间戳） | 对应 Codex 的 idle |
| G3 待审压力 | pending 候选 ≤ K（默认 20） | 待审积压时先清积压，不做二次抽象 |
| G4 预算 | 当日 dream token 预算未用尽；最近一次模型调用失败率 < 阈值 | 对应 Codex 的 rate-limit 阈值 |
| G5 独占 | `node:sqlite` 全局锁 + owner token + 1h lease + 90s 心跳 | 多进程/多宿主 |
| G6 用户开关 | 配置 `dream.enabled` 默认 false；首次启用需人工确认 | 隐私与成本 |

失败与恢复：lease 过期视为 abandoned，保留部分产出供检查；未开始的工作可重领，已领取不重发
（沿用现有 `capture-jobs` 的语义）。**不做“夜间定时器”**，只做“事件到来时按水位判断”。

## 5. 输入：三档并集，全部封顶

| 档 | 内容 | 上限 |
|---|---|---|
| A 变更集 | watermark 之后的 capture、未审候选、冲突对（`I7` findings） | ≤ 50 条 |
| B 热点集 | 近 30 天被 `memory_search` 命中或被注入的条目 id（需先有 L3 使用计数） | ≤ 30 条 |
| C 冷抽查 | 随机抽样做陈旧/衰减检查 | ≤ 20 条 |

transcript 用已有会话日志，**不全库扫描**。输入本身只读；所有 op 必须带 evidence（原话引用、
recordId、或 detect finding id）。

## 6. 操作清单（按风险从低到高）

| # | 操作 | 确定性？ | 安全闸 |
|---|---|---|---|
| D1 | 同键去重合并（`conflictSignature` 相同且仅一处取值不同） | 确定性 | 只归档不删除；保留双方 recordId |
| D2 | 索引压缩：>300 行/25KiB 时把细节移到主题文件、索引留摘要 | 确定性 | 先 shadow diff；可回滚 |
| D3 | 索引/正文对齐（I3/I13 修复） | 确定性 | 以账本为准重建正文块；不新写事实 |
| D4 | 撤回残留清理（I5） | 确定性 | 复用现有撤回发布路径 |
| D5 | 冲突仲裁：同一属性多个取值，留最新并写 `supersedes` | 需人工 | 必须显示两个取值与来源；默认不自动应用 |
| D6 | 衰减归档：长期未引用 + 过期 + 低重要度 → archive 区 | 确定性 + 人工 | 不删除；可恢复 |
| D7 | 建链：related / contradicts（不产新正文） | 确定性（相似度） | 只增边；可 `memory_links` 查 |
| D8 | 按 transcript 纠错（对照原话改摘要） | 需模型 | 必须列出原话引用；改注入层需人工确认 |
| D9 | 洞察（≥2 条既有记忆归纳） | 需模型 | 必须列引用 id；禁止无引用新事实；每日上限 |

**禁止**：整库重写、无证据改写、自动删除主题文件、自动改写用户手工条目（I4 类）。

## 7. Shadow 库 + diff + 人工确认

Anthropic 的 Dreams API 用“输出新 store、输入不变”换安全；SoloPup 用更细的 **op 计划**换可审计：

1. dream 只写 `<store>/.dream/<runId>/`（计划 JSON + 预览 Markdown），不碰正式库。
2. 每个 op 记录：`{opId, kind, target, beforeHash, afterHash, evidence[], risk}`。
3. `scripts/dream.mjs status|diff|apply`：
   - `diff` 输出人类可读的 before/after 与证据；
   - `apply` 需要 `--reviewed <planHash>`，逐 op 原子应用；每个 op 幂等（content hash + opId）。
4. 崩溃恢复：op 日志 + 发布锁；已应用 op 不重复，未应用可续。
5. 任何 op 失败不阻断主对话；失败进 `.audit.jsonl`，`memory_status` 可见。

## 8. 指标（dream 前/后对比）

| 指标 | 定义 | 门槛（建议） |
|---|---|---|
| 索引行数/字节 | 注入预算占用 | 不增长或下降 |
| 同键重复数 | I6/I7 计数 | 下降 |
| 未仲裁冲突数 | I7 | 下降 |
| 投影不一致数 | I3/I13 | = 0 |
| 撤回残留 | I5 | = 0 |
| 冷启动召回 | 冻结查询集（L2） | 不下降 |
| 新事实幻觉率 | 人工复核 op 中有无 evidence | = 0 |
| 每轮 op 数 / token / 时长 | 账本统计 | 有上限 |

评测方式：固定 20–30 条**真实历史查询**做 dream 前/后盲评（沿用项目现有盲评流程），不做线上 A/B；
golden set 加一条禁止项“不得出现无 evidence 的新事实”。

## 9. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 影子报告 | 只跑检测 + 生成 op 计划，不落盘（已实现：`node scripts/dream.mjs`） | `dream` 能解释每个 op 的证据，`--json` 可审计；`applySupported=false` |
| P1 确定性整理 | `compact-index` 自动 apply（`pruneStore`，带备份与 reviewed 哈希）；其余 op 明确跳人工 | 临时库验证：超限索引回落、重复/过期移除、可重复执行、验证不恶化 |
| P2 冲突与衰减 | D5、D6 自动建议 | 冲突数下降；无“越整理越错”的人工复核 |
| P3 模型类操作 | D8、D9（默认关闭，人工确认） | 幻觉率为 0；成本在预算内 |

## 10. 与“做梦”相关的设计取舍

- **不抄整库克隆**：SoloPup 的账本已经比一次性重写更细；整库替换会丢掉撤回屏障与历史。
- **不抄“自动应用”**：Anthropic 的 API 让调用方拿新 store 自行决定；我们也必须让人看见 diff。
- **不抄“全量校验”**：官方自己说全量不划算；用易变度/访问频率决定查什么。
- **不引入第二事实源**：dream 的产出仍走 `writeMemory` 的同一套闸门（来源、审查、去重、配额）。
- **保留“什么都没做”**：没有值得整理的变更时，dream 必须能返回空并记录“跑过但无 op”。

## 11. 开放问题

1. L3 使用计数还没实现，B 档热点集暂时只能靠 `memory_search` 的审计日志反推。
2. 主题文件当前是自由 Markdown，D2 的“细节下移”需要先定义卡片块边界（`[candidate:id]` 已可用）。
3. 多宿主并发下，“静默 ≥20min”需要一个共享时钟来源；目前只能看本地 `capture-state.json` 时间戳。
4. dream 的模型调用是否复用自动捕获的 provider/model，还是允许单独配置（建议后者，便于限额）。
