# SoloPup Memory

**新用户入口：** [快速上手](docs/guides/quickstart.md) · [六个虚构试用案例](docs/README.md) · [常见问题](docs/faq.md) · [反馈](docs/feedback.md)

**记住重要的事，跟上你的改变。** · [English](README.en.md)

当前公开版本为 **0.21.0-beta.3**，是文字记忆测试版，尚未通过稳定版验收。已验证范围和已知问题见 [RELEASE.md](RELEASE.md)。

把用户明确表达的长期偏好、项目决定、可查证线索和暂定信念保存下来，在后续对话中按项目与适用条件找回。首次公开版本只处理文字。

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

## 安装与卸载

使用 DeepSeek Harness 官方插件管理器安装。代码为可直接执行的 ESM，无安装时构建脚本，也不需要 npm 账户。以下以 desktop profile 为例。

```sh
dsh plugin --profile desktop add solopup-memory@0.21.0-beta.3 --ignore-scripts
```

npm 上的 beta.3 已公开并完成下载核验，`beta` 标签指向 beta.3。上面的命令固定本次修复版本；Git 安装可用 `dsh plugin --profile desktop add github:OakcoderX/solopup-memory#v0.21.0-beta.3 --ignore-scripts`，需要不可变 Git 来源时，用发行页的完整提交 SHA 替换标签。也可下载发行页的 `.tgz`，使用 `dsh plugin --profile desktop add /absolute/path/to/solopup-memory-0.21.0-beta.3.tgz --offline --ignore-scripts`。

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

```sh
npm test
node scripts/verify.mjs --no-accept
node accept.mjs --profile desktop
```

`verify --no-accept` 运行源码测试、隔离加载、原有机械评测及可用性检查；需要本地可用的 DSH。`accept` 只读核对实际 profile 安装与运行状态。实际归档和官方宿主另行验证；真实模型、冷启动召回、逐条语义复核及持续使用不能由这个命令替代。

详细安全边界见 [SECURITY.md](SECURITY.md)，宿主兼容范围见 [COMPATIBILITY.md](COMPATIBILITY.md)。

用户单条消息的完整来源窗口目前上限为 2000 字符。超长消息不从前半段建立记忆；自动整理显示来源不完整并暂不执行，主动写入也拒绝使用仍在当前核对窗口内的截断来源。可在新的短消息会话中完整重述需长期保留的约定。这个修复不会自动纠正旧版已经保存的解释。

市场源请求失败时，按 [DSH 官方代理手册](https://deepseek-harness.github.io/deepseek-harness/guide/network-proxy) 配置 DSH 自身的代理环境；DSH 不自动读取 macOS 系统代理。
