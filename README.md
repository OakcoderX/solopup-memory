# SoloPup Memory

**让 DSH 记住你的工作偏好和项目约定，下次继续时少一些重复交代。**

SoloPup 是 DeepSeek Harness（DSH） 的文字记忆插件。它尝试保存值得长期保留的信息，帮助 DSH 在后续工作中找回并参考。**当前稳定版为 0.27.0。** 记忆可能保存或召回失败，重要内容请核对。

[安装稳定版](docs/guides/quickstart.md) · [0.27.0 发行页](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.27.0) · [历史评测](docs/runs/2026-11-18-memory-delivery.md) · [历史 12 题逐题成绩](docs/runs/2026-11-20-frontiermemory-text.md) · [做梦交互演示](https://oakcoderx.github.io/solopup-memory/dreaming/) · [0.24 做梦历史实验](docs/research/dreaming-in-dsh/README.md) · [更多示意案例](docs/README.md) · [常见问题](docs/faq.md) · [English](README.en.md)

## 闲置时复核明确更正

**项目约定改了，下次打开 DSH 就能用。** 为选定项目开启自动应用（`dream.autoApply`）后，SoloPup 会在闲置时核对本次运行收到的明确更正。能对上原话和唯一一条现行约定时，它会更新受支持的一个值，保留原有条件和例外。做梦报告会列出改了什么、依据哪条消息。自动应用默认关闭，试行或证据不足的更正留待复核。 [设置、查看回执与撤回](docs/dream-review.md)

同一台 Mac 上用 DSH 和 DeepSeek Flash 跑了一次对照。后台**只出报告花了 600 token**，重启后新会话仍回答「正式交付用中文」。**自动应用花了 605 token**，重启后回答「正式交付用英文」。内部审片批注用中文的例外在两组都保留。这个结果来自 beta.2 的普通 DSH 单个语言更正案例，不代表本安装包的验收结果。 [实测设置、前后台用量与结果](docs/runs/2026-11-25-dream-auto.md) · [0.27.0 桌面验收回执](https://github.com/OakcoderX/solopup-memory/releases/download/v0.27.0/desktop-acceptance.json)

新版也能在受支持的宿主上打开记忆对应的 DSH 原消息，查看本轮实际保存了什么、模型请求里带了什么、交付文件核对到了哪一版。 [本版完整更新](RELEASE.md)

升级前请先备份。做梦与自动应用均需主动开启；自动应用只支持严格格式的交付语言、交付格式和交付模板版本的单值更正。其他情况留待复核。[设置与撤回](docs/dream-review.md) · [跨版本回退](docs/dream-rollback.md)

## DSH 养鱼：换个会话，大肥鱼还记得你刚改的称呼吗？

如果你在 **DeepSeek Harness（DSH）的原生文字会话**里养大肥鱼、聊看片单或一起写点东西，可以用 SoloPup Memory 试着保存几条长期偏好。它不是桌宠，也不接管 QQ、B 站机器人或其他插件的记忆库。如果你用的桌宠已经有独立记忆，先用同一方法测试现有方案，不必叠装。

**三步自测：** 在不含私人资料的试用工作区，先说「记住：只在这个养鱼测试工作区叫我小柚」，看到正式写入成功后，再说「把这个工作区的称呼改成小栗，替换旧称呼，不是再加一个」。确认替换成功，然后在**同一工作区开不继承历史的新会话**，只问「这个工作区你该怎么称呼我？可以给我看你依据的原话吗？」不要在新会话里透露答案。

答「小栗」且能指出更正的来源，是这次召回的预期结果。再换到一个没有这条约定的工作区问一次，那里不应沿用这个项目称呼。如果仍答旧称呼，或工具显示待审、拒绝、未应用，就不要记作成功。这是可以自己复跑的虚构案例。试用时请检查是否真正写入和召回。

[完整养鱼教程：改称呼与新会话自测](docs/guides/dsh-fish-memory.md) · [开始安装和核对版本](docs/guides/quickstart.md) · [如何验证跨会话记忆](docs/guides/fresh-chat.md)

## 用起来是什么感觉？

**改哪一稿，交回的文件末行对不对？** 在普通会话首行写 `本轮稿本：审读版`。已保存且带稿本条件的项目约定就能按本轮选择判断适用性。对已按约定格式保存的精确末句，DSH 可以重新读取作者指定的 Markdown 文件并返回核验结果。[选稿与核验示例](docs/guides/manuscript-delivery.md)

下面是**虚构的使用示意**，帮助理解用途，并非实测对话：

**今天，你说：**“记住，我希望邮件简洁、礼貌，不要太正式。”<br>
**SoloPup：** 检查并尝试保存这条偏好。

**以后，你说：**“帮我写一封会议后的感谢邮件。”<br>
**DSH：** 如果成功找回偏好，可能写出：“感谢今天的交流，期待接下来的合作！”

项目中也可以记住约定：例如做旅行计划时记录预算，或者写故事时记录已经确定的人物设定。记忆是否生效，需要看实际保存和召回结果；重要决定仍应核对原话。

## 长篇项目可以回查到原话

比如你写到第七章，讨论了几份稿，最后确认「第七章用 V2，结尾照旧」。DSH 压缩聊天后，SoloPup 的做梦复核可以找回这条明确更正，包括句尾的例外。要续写正文，可以把采用决定绑定到 V2 的 Markdown 章节。下次打开会核对当时的文件指纹，稿件有变动时会提示你。 [做梦回查方式](docs/dream-review.md) · [绑定与读取 Markdown](docs/guides/markdown-reference.md) · [0.25 对照与复跑](docs/runs/2026-11-14-long-project-beta.md)

## 按当前约定交付

0.26 在工作开始时呈现少量与任务有关的现行约定，并保留来源、条件与例外。支持的 DSH 宿主在任务改动文件并正常收尾时，可以提示一次交付复核。模型仍需要实际检查文件和测试。历史评测报告列出各次测试实际使用的版本、得分、失分和复跑方法。欢迎下载源码或在 GitHub Fork 后，用自己的项目案例复跑和改进。 [历史评测与复现](docs/runs/2026-11-18-memory-delivery.md) · [下载源码](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.27.0) · [Fork](https://github.com/OakcoderX/solopup-memory/fork)

## 闲置做梦复核

你原来约定「样片交付说明默认用中文」，后来明确改用英文。开启做梦并选好项目后，SoloPup 会等 DSH 闲置，核对旧记忆和更正原话，再把建议放进报告。默认由你确认并正式写入。在 0.27.0 里，也可以为所选项目开启自动应用，让通过来源核对、范围明确的单值更正直接生效。

**记住旧约定 → 闲置时回查原话 → 查看报告并确认，或按你开启的设置自动应用 → 新会话可以获得新约定**

普通 DSH 可以独立完成复核。已配置 Super Agent 的用户可切换到实验模式，由隔离的 Worker 负责复核。两种方式共用项目记忆、队列和报告，切换会等当前工作结束。做梦默认关闭。 [开启与切换](docs/dream-review.md) · [0.27 自动应用对照](docs/runs/2026-11-25-dream-auto.md) · [0.24 历史实验](docs/runs/2026-11-13-dream-review-beta1.md)

## 记忆如何帮上忙？

**① 你说出值得记住的事**<br>
↓<br>
**② SoloPup 检查并尝试保存**<br>
↓<br>
**③ 后续任务中，DSH 获得摘要或查找记忆**<br>
↓<br>
**④ AI 结合当前任务判断并回答**

记忆是给 AI 参考的背景，不保证每次都被保存、找回或正确理解。你也可以查找来源、提出修订；[了解工作过程与限制](#工作过程)。

## Super Agent 能用吗？

Super Agent 负责安排和推进任务。SoloPup 的实验性接入可为执行任务的 AI 提供之前保存的项目约定。

**配合流程示意：**

你让 Super Agent 继续整理项目<br>
↓<br>
Super Agent 安排 AI 执行具体任务<br>
↓<br>
配置满足条件时，执行任务的 AI 可能收到 SoloPup 的项目记忆摘要<br>
↓<br>
AI 结合当前任务和记忆判断，再继续工作

这是简化示意，不表示所有任务都会自动获得记忆，也不保证 AI 一定正确使用。

可以在**满足配置条件时**为 Super Agent 的任务提供项目背景：先显式关联同一仓库的工作区，负责具体任务的 AI 才可能收到项目记忆摘要。

在 0.24 的两个虚构项目对照中，我们实际重启 DSH，再由同一线程的消息恢复原 Super Agent 任务。旧检查点仍在。关闭做梦时，两个 Worker 继续用旧值。做梦建议经人工确认写入后，两例都改用新值，并保留原例外。跨夜用任务引擎的逻辑时钟模拟。 [看跨天恢复实测](docs/research/dreaming-in-dsh/README.md#第二天旧检查点还在)

Super Agent 原型准备失败后直接重试，Worker 可能缺少项目记忆，工具取决于 Worker 的设置。旧会话副本仍可保留已经撤回的内容。针对 0.27 的复测在 DSH `0.2.2-rc.3` 发现工单结算兼容问题。 [接入条件与限制](docs/runs/2026-11-12-superagent-examples.md) · [DSH 官方反馈](https://github.com/deepseek-ai/deepseek-harness/discussions/14293)

## 先试起来

需要已安装 DeepSeek Harness，Node >=24.9。以下以 desktop profile 为例：

```sh
dsh plugin --profile desktop add solopup-memory@0.27.0 --ignore-scripts
```

如果 DSH 更新后出现 `memory-context-render-mismatch`，请按[升级指南](docs/guides/quickstart.md)安装当前稳定版、重启 DSH，再回到原对话重试。原来的聊天记录可继续使用。

重启该 profile 的宿主后，用 `memory_status` 确认插件版本与状态。升级旧名 `dsh-memory` 前先完整备份并移除旧插件，不能同时启用两个插件；固定版本、旧库检查和卸载见[安装与卸载](#安装与卸载)。

## 原话来源会怎样返回？

下面是 **2026-11-07 在 Linux x64 / Node v24.22.1 实际执行的离线示例输出**，使用虚构消息、生产工具处理函数和脚本化宿主；审查回复由测试桩固定通过。写入、同项目检索、另一项目检索分别在三个新 Node 进程中运行，后两者不继承旧消息。**这不是实际 DSH 聊天或真实模型的语义验收。**

```text
synthetic user: 记住：本项目的交付说明统一用中文。
memory_write: recorded (scope=project, meaning=decision)
fresh process / memory_search("交付说明"): 1 hit (scope=project)
current text: - [project] 本项目的交付说明统一用中文 — 索引摘要
history source: synthetic-demo-write:1; quote: 记住：本项目的交付说明统一用中文。
other project / current + history: 0 + 0 hits
```

当前查询返回有效摘要；另一次 `memory_search({query: "交付说明", mode: "exact", view: "history"})` 返回原话及消息来源，历史内容不能当作当前指令。以上六行是工具结果摘要，完整返回值和局限见[运行记录](docs/runs/2026-11-07-source-recall.md)。在源码目录运行 `node scripts/demo-source-recall.mjs` 可复现；真正的[换聊天验收](docs/guides/fresh-chat.md)仍需在 DSH 中另做。

## 个人资料与按需读取

已识别的生日、性别、健康、亲密关系和私人联系方式默认不进入自动索引投影，也不作为无关后台整理或写入审查的旧记忆发送。普通 `memory_search` 默认隐藏这些内容；用户询问相关资料时，才明确使用 `includePrivate: true`。主题文件含有未分段的敏感内容时，普通搜索会保守跳过整个主题文件，安全的索引摘要仍可检索。

这是内容规则提供的降载保护，不是完整的隐私分类器。未识别的改写仍可能漏过；文件工具仍能读原始文件，按需读取结果也会进入当前会话日志和模型请求。此版本没有把原始 `MEMORY.md` 改成无明文的指针库，没有擦除既有日志、缓存、备份或已发送数据。`memory_forget` 表示停止使用索引条目，不表示彻底删除个人信息。

## 工作过程

1. 从本会话已接收的用户消息提出候选，并绑定原话引用。
2. 独立检查持久价值、归属、措辞、认识类型、适用条件、信念归属和修订关系。审查不能改写候选。
3. 通过检查后才发布到有效记忆。明确拒绝的不写入；无法判断的新候选可以留在不自动注入的待审区。未通过的替换请求不降格成普通追加。
4. 后续对话自动得到受预算限制的索引；检索同时查当前项目与全局库，结果标明归属。其他项目不会因此自动变成当前项目的记忆。

用户明确要求记住持久信息时，插件指令要求本轮使用正式 `memory_write`，等待实际结果再确认；不等待后台整理。本人陈述的个人资料按未独立核实的 `claim` 保存，助手猜测不能冒充本人确认。模型仍可能不遵循指令，因此需要实际调用与新会话验收。

默认每四轮尝试一次后台整理。主动 `memory_write` 也经过来源审查。`pending-review`、`rejected`、`not-applied` 都不表示已经记住。

## 记忆的层次

| 层次 | 内容与用途 |
|---|---|
| 来源 | 用户原话与消息身份；工具观察另带当时输出的核对证书 |
| 候选 | 尚待判断的解释；待审内容不进入常规有效记忆 |
| 有效记忆 | 全局个人约定或当前项目内容，带条件、例外及可选期限 |
| 修订历史 | 解释旧值与新值的关系；旧值不能继续冒充当前默认值 |
| 认识状态 | 偏好、决定、未核实主张、暂定信念、价值取向、查证入口和经历分别表示 |

“我负责剪辑”可以保存为本人报告的分工，但不等于外部事实已被独立证实。信念可以保留竞争解释和反证条件；这不是完整的 POMDP 概率求解器。记忆也不构成发邮件、购买、删除或发布的操作授权。

## 存储与修改

Markdown 索引和主题正文便于阅读；来源、候选、历史与调用记录使用有格式校验的本地账本；独立 SQLite 控制库维护受管身份、撤回和协调状态。不要只备份 Markdown 就认为已完整备份系统。

改同一条约定的值时，`supersedes` 指向唯一现行旧行，默认保留原来的归属、认识类型、条件、例外和期限及其来源。改变这些边界时使用完整重述路径 `revisionMode=replace`，由本轮用户来源支持全部新内容。仅确认“其他项目也一样”不应再建副本。兼容补充不自动变成一般规则的例外。

条件全部成立才满足 `conditions`；任何一个例外成立就命中 `except`。同一条件不能既必须成立又必须排除。来源上限超出时明确拒绝，不截掉必要来源来凑数。

## 跨 worktree 项目记忆（0.23 测试版）

以下功能从 0.23.0-beta.1 开始提供，不属于 0.22.0-beta.3。默认各工作目录仍使用各自的项目库。若主 Agent 与 Worker 使用同一 Git 仓库的不同 worktree，可在源码或安装包目录中通过本地命令显式关联：

```sh
node scripts/projects.mjs link --cwd /path/to/worker-worktree --owner /path/to/project-worktree
# 核对预览后，将返回的 reviewed 填入：
node scripts/projects.mjs link --cwd /path/to/worker-worktree --owner /path/to/project-worktree --apply --reviewed-link <reviewed>
```

来源目录须已有项目库；Worker 若已有独立项目库，命令会拒绝，不会合并或覆盖。关联会检查本地仓库身份，不自动关联克隆；仓库或文件系统迁移后可能需要重新登记。取消关联同样先预览、再使用 `reviewed` 执行，且不删除记忆：

```sh
node scripts/projects.mjs unlink --cwd /path/to/worker-worktree
node scripts/projects.mjs unlink --cwd /path/to/worker-worktree --apply --reviewed-link <reviewed>
```

取消关联只改变之后的目录解析，不是运行中任务的即时撤权：已解析出的项目库路径、正在处理的捕获任务及已进入会话的内容不会因此自动失效或删除。需要停止使用该共享关系时，先停止相关 Worker 和记忆捕获，再取消关联；历史副本须另行检查。

超级 Agent 的准备命令可以在创建 worktree **之后**，显式追加以下命令，自动登记该次 Worker 目录。请将路径替换为本机的绝对路径；这是一项用户主动配置，不会自动改写超级 Agent 设置。若创建或登记失败，本次启动会停止；超级 Agent 原型重试时可能因目录已存在而跳过准备命令，不能直接重试，须先检查残留目录并确保准备步骤会重新执行。

```sh
node /absolute/path/to/solopup-memory/scripts/superagent-worktree.mjs --owner /absolute/path/to/project-worktree --apply
```

该命令读取超级 Agent 提供的 `DSH_SUPERAGENT_DIR`，仍执行同仓库和已有独立库检查；`--apply` 表示用户在准备配置中授权执行关联。

在测试的超级 Agent 原型中，Worker 的默认工具限制不开放 `memory_search` 或 `memory_write`。关联可以让已登记的项目记忆进入 Worker 上下文，但不表示 Worker 可直接调用这些记忆工具；不要将其视为 Worker 主动写入记忆的支持。

关联不会清除已发送给模型或保存在普通会话中的副本。真实模型语义质量和全部跨平台环境尚未验收。

从 0.23.0-beta.2 起，记忆协议提示模型在任务历史与长期记忆不一致时核对来源、范围和时间；用户明确更正后按新要求工作，无法判断时向用户澄清。提示不能保证模型一定判断正确，也不会自动更改历史任务、清除会话副本或代替现有记忆写入审核。Worker 未配置记忆工具时，不能声称已经写入记忆。

## 安装与卸载

使用上方[先试起来](#先试起来)的 DeepSeek Harness 官方插件管理器命令安装。代码为可直接执行的 ESM，无安装时构建脚本，也不需要 npm 账户。

`latest` 跟随当前稳定版，发布当天或需要复现时可固定为 `solopup-memory@0.27.0`。需要主动试用预览版时再选 `@next`（候选）或 `@beta`（测试）。Git 安装可用 `dsh plugin --profile desktop add github:OakcoderX/solopup-memory#v0.27.0 --ignore-scripts`，需要不可变 Git 来源时，用发行页的完整提交 SHA 替换标签。也可下载 `.tgz` 后运行 `dsh plugin --profile desktop add /absolute/path/to/solopup-memory-0.27.0.tgz --offline --ignore-scripts`。 [发行页与校验值](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.27.0)

已安装旧名 `dsh-memory` 时，先完成完整备份、关闭使用该库的宿主，用官方管理器移除旧包，再安装新包；不要同时启用两个记忆插件。新名字继续使用原记忆库和控制格式。

重启该 profile 的宿主后，用 `memory_status` 核查插件版本、全局/项目状态及捕获诊断。已有旧库可能进入需要核对归属或旧撤回策略的状态；按本地预览结果处理，不删除控制文件绕过检查。

```sh
dsh plugin --profile desktop remove solopup-memory
```

可在插件页的实验插件中启用 **Custom plugin markets**，进入 Discover → Add index source，导入：

```text
https://raw.githubusercontent.com/OakcoderX/solopup-memory/main/market/index.json
```

这是自托管插件源，按官方格式提供；DSH 不默认内置任何市场源，不表示官方审核或推荐。

卸载保留记忆数据。重新安装同一位置的数据仍需通过身份与格式检查。

## 备份与恢复

先关闭使用这套记忆库的全部宿主与写入器。使用安装目录中的脚本，备份目标必须是不存在的新目录。

```sh
node /absolute/plugin/scripts/backup.mjs create --root /absolute/memory --to /absolute/new-backup
node /absolute/plugin/scripts/backup.mjs verify --snapshot /absolute/new-backup
node /absolute/plugin/scripts/backup.mjs restore --root /absolute/memory --snapshot /absolute/new-backup
```

恢复默认只预览。核对返回的目标、格式能力及 `review` 后，以相同参数加 `--apply --reviewed HASH` 执行。恢复保留当前撤回控制，不能靠旧快照重新启用已撤回来源；恢复数据也不会自动安装旧代码。

备份包含可能敏感的记忆正文，应保留在私有位置；不包含独立凭据、profile 或原始会话。中断恢复使用 `backup.mjs resume` 核查，不能通过删日志或控制库跳过屏障。

## 使用边界

- 模型可能漏记、误判或错误概括。重要决定应查原话与来源；程序格式检查不等于语义正确。
- 当前检索使用中英文词元及精确匹配，没有向量检索，不保证跨语言或同义表达的召回。
- 撤回覆盖受管库内已追踪的来源及相关投影；不承诺清除原始对话、远端服务、外部备份和未知副本。
- 未决的远端请求不会自动重发。调用次数、执行完成和真实计费分别记录。
- 当前验证环境为 macOS、DSH 宿主 Node 24；其他平台的验证状态以发行验收清单为准。

MIT License，Copyright © 2026 oakfilm。产品品牌：SoloPup Memory。

## 开发验证

测试集中在 `test/`，运行时模块保持原路径。`npm test` 和安装包都保留完整的显式测试集合。

```sh
npm test
node scripts/detect.mjs --check   # L0 不变量检测（只读）；有 error 退出码 1
node eval/semantic-suite.mjs     # L2 管道保真层（10 条冻结用例）
node eval/bench-detect.mjs       # 对比实验：检测器召回与耗时
node scripts/dream.mjs           # 做梦 P0 影子计划（只读）
node scripts/security-check.mjs  # 发版前机械安全自查
node scripts/soak.mjs            # 可靠性测试：官方安装 + 真实宿主多轮 + 崩溃恢复
node scripts/verify.mjs --no-accept
node accept.mjs --profile desktop
```

`verify --no-accept` 运行源码测试、隔离加载、原有机械评测及可用性检查；需要本地可用的 DSH。`accept` 只读核对实际 profile 安装与运行状态。实际归档和官方宿主另行验证；真实模型、冷启动召回、逐条语义复核及持续使用不能由这个命令替代。

详细安全边界见 [SECURITY.md](SECURITY.md)，宿主兼容范围见 [COMPATIBILITY.md](COMPATIBILITY.md)。

单条用户消息的完整来源窗口最多 8 KiB，另受整次模型输入预算约束。超过上限时会标出来源不完整，仍在当前核对窗口的截断来源会阻止写入。可另发一条完整短消息，把要长期保留的约定、适用范围和例外一起写清。

市场源请求失败时，按 [DSH 官方代理手册](https://deepseek-harness.github.io/deepseek-harness/guide/network-proxy) 配置 DSH 自身的代理环境；DSH 不自动读取 macOS 系统代理。
