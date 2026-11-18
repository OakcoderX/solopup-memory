# SoloPup 0.26 的记忆交付评测

在两个小型交付任务中，0.26 使用最新约定完成了 **2/2**，公开版 0.25 是 **1/2**，关闭插件是 **0/2**。三个条件都完成了 **2/2** 的主任务。0.26 的得分来自最终工作区里的文件和可执行检查。它还在最后一轮 cattrs 官方单题评分中取得 **1/1**。中文续写测得 **3/4**，暴露了文件末尾要求仍可能漏验。

| 真实 DSH 检查 | 关闭插件 | 0.25.0-beta.2 | 0.26.0-beta.1 |
| --- | ---: | ---: | ---: |
| 施工交接说明使用新的回执 | 失败 | 通过 | 通过 |
| CLI 输出变更附验证命令与新签收标记 | 失败 | 失败 | 通过 |
| 合计按最新约定交付 | 0/2 | 1/2 | 2/2 |
| 主任务通过 | 2/2 | 2/2 | 2/2 |

两个样例都用 DSH `0.2.2-rc.3` 和同一官方 DeepSeek Flash，温度 0，关闭思考，每组限时 90 秒。开启插件的两组收到同一份经核对的、有出处的项目约定，旧记录按原机制被替代。任务正文没有重述回执值或配套文件要求。交接说明检查正文与末行回执，CLI 题分别运行旧用法和新用法，再检查独立的交接文件。最终候选用全新会话复跑，两题都按约定交付，且每题只收到一次复核提示。

较早的 0.26 候选在这两题得 **1/2**。它找到了 CLI 题的现行约定，也触发了复核，却把普通项目内配套文件误判为需要额外授权。修订提示后，第二轮轨迹显示模型先写 `meter.py`，收到一次宿主收尾提示，随后补写 `ops/rollouts.md`。两题用于迭代，最终小样本结果应理解为可复现的回归对照。

## cattrs 官方题的本地对照

使用固定的 Harbor `letta-ai/frontier-memory@v1.0` cattrs 题包和其官方校验器。三组使用同一源码、题目和连续的 20 分钟额度。两个记忆组从同一批公开历史预装经过核对的来源记录。官方完整榜单还有从完整语料盲生成记忆以及多题重复运行的阶段。

| cattrs 官方检查 | 关闭插件 | 0.25.0-beta.2 | 0.26.0-beta.1 |
| --- | ---: | ---: | ---: |
| 严格整题分数 | 0/1 | 0/1 | 1/1 |
| 原有行为通过 | 7/7 | 7/7 | 7/7 |
| 新增检查通过 | 67/70 | 69/70 | 70/70 |
| 文档、可运行示例、更新日志 | 1/3 | 3/3 | 3/3 |
| 模型请求数 | 见回执 | 316 | 138 |

关闭组达到 20 分钟时限。0.25 在约 13 分钟结束，最终 0.26 在约 8 分 44 秒提交。0.26 的更新日志先于复核写入。前两轮候选同样通过三项偏好检查，但新增检查分别只过了 62/70 和 63/70。整题差异包含这次实现和模型执行的变化，单次成绩的波动已经体现在报告中。 [官方题目](https://frontiermemory.com/tasks/cattrs-compositional-changelog/) · [评分与运行回执](../../eval/memory-delivery/results.json)

## 中文改稿留出检查

《候潮旅社》是虚构案例。要写一份审读版结尾，文件需要用修订后的离开地点、保留原定末句，并采用审读版有别于默认版本的声音。关闭组超时 **0/4**，0.25 与最终 0.26 都是严格 **3/4**。0.25 保住末句，用近义表述写了环境声。0.26 写对新地点和指定声音，但在正文后加了审读备注。复核命令只检查了正文首段，遗漏了整个文件的真正末尾，模型仍报告完成。 [冻结案例与复跑](../../eval/memory-delivery/fiction/README.md)

## 宿主和发布检查

原生固定响应探针确认了正常收尾中的单次复核。另用实际安装的 DSH Desktop 做冷启动接续，用显式关联的 Git worktree 复查项目范围。已关联的普通会话可进入复核，已播种或委派的会话保留原有记忆入口。本轮全量模型对照使用普通 DSH。

安装包验收运行 1,116 项测试，包含 6 项按现有配置跳过的测试。真实宿主通过了全新加载、重复压缩、冷启动和卸载检查。另在隔离 profile 中按卸下再安装流程完成了 0.25 → 0.26 → 0.25，同一份项目记忆的文件校验值保持一致，每次启动都能读到当前约定。

## 复跑和贡献

报告保留各组分母、复核是否送达，以及评分依据。欢迎下载源码或 Fork，在自己的 DSH 上重跑，提交带任务、初始约定、输出检查和版本的案例。测试题、隔离运行和评分代码见仓库。 [复现步骤](../../eval/memory-delivery/README.md) · [源码与安装包](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0-beta.1) · [Fork](https://github.com/OakcoderX/solopup-memory/fork)

## English summary

On two local delivery tasks, preference compliance was **0/2** without the plugin, **1/2** with 0.25.0-beta.2, and **2/2** with 0.26.0-beta.1. On one local run of the official cattrs task, the strict scores were **0/1**, **0/1**, and **1/1**. Both enabled arms received the same pre-reviewed, source-linked conventions. The final candidate scored **3/4** on a separate Chinese writing fixture, matching 0.25. It missed the required ending at the end of the whole file and mistakenly reported that it had checked it. The source includes the test setup and score records. [Reproduction](../../eval/memory-delivery/README.md)
