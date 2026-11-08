# 兼容性

> dev.33开发格式：来源账本schema4与受管历史schema2用于字段来源。仅发生字段继承才升级；没有继承的新普通写入继续使用旧格式。新读取器接受来源1—4和历史1—2；旧读取器不得把未知格式当成空库。备份恢复在写入前按目标包的`dshMemoryDataSchemas`声明检查格式；未声明的旧protocol1包仅按原来源1—3/历史1处理，声明只表明契约，实际兼容仍须实测。恢复代码本身不安装或切换目标包。

> dev.31：已在实际宿主观测到ctx.get('llm')、ctx.llm及对应方法均可返回不同代理；这不表示提供者已更换。原生审查通过ctx.inject(['llm'], child)绑定活动提供者，使用child.effect清理及代次变化取消旧调用，不比较重复get得到的对象身份。无注入机制的旧上下文仍由现有兼容观察器刷新服务；不新增私有API依赖。

> dev.30：原生写入使用同一公开llm.prepareCall和单个submit_memory_validation工具契约，不用提供方私有结构控制。关闭自动捕获仍需原生审查；无llm或明确路线时新长引文候选仅待审，其他情况明确未写入，不默认改选账户。工具结果新增可选status/reason/candidateId，原有必填字段保留，渲染先检查未发布状态。原生审查仍是零条目作业，native-write-validation审计用于区分阶段；既有调用账本与诊断枚举不变。实际安装、回退和真实模型效果由单独报告确认。

> dev.28：仍使用公共prepareCall/GenerateOptions.tools契约；验收任务单独声明submit_memory_validation，不使用提供方私有结构控制。调用账本与捕获诊断未增加字段或枚举；子调用以独立哈希身份记录，明细通过有界审计计数区分。实际安装/回退及模型效果须由本候选报告确认，不能从源码可加载推断已通过。

> 记录：插件依赖宿主（DeepSeek Harness）的哪些具体行为，以及这些结论是**从哪份源码/文档读来的**。
> 宿主升级后按 §4 的步骤复验。

> 2026-10-29 官方开发指南核对：主干文档与本机0.2.1-rc.3分别留证，不能把主干能力自动算到安装版本。v0.18.0补充官方`dsh.bundle.patch`入口、同步Standard Schema V1配置校验、`ctx.get(name)`可选活动服务获取和卸载取消。手写原生JSON Schema工具是官方明确允许的形态，自行校验输入；零SDK运行时导入是本插件的兼容选择，不是官方禁令。官方的peerDependencies规则也提供共享宿主模块的路径，本插件当前无需运行时SDK导入。

## 1. 已验证的版本

| 组件 | 版本 | 说明 |
|---|---|---|
| DeepSeek Harness（桌面，历史验收） | **0.2.1-rc.3** | 既有桌面记录；不是本候选的新桌面验收 |
| DeepSeek Harness（Linux 隔离 CLI） | **0.2.1-rc.5、0.2.2-rc.1** | 官方 npm 分发；真实 Loader、Session 与投影生命周期，合成输入、零模型调用 |
| Node | 24.21.0 | 宿主内置；本机另装 v25.8.1 用于跑测试 |
| `engines.dsh` | `>=0.2.1-rc.0 <0.3.0` | package.json 声明；0.3 需要重新验证 |

## 2. 依赖的宿主 API

| 依赖 | 用法 | 证据 |
|---|---|---|
| `ctx.systemPrompt.context(entry)` | 注册 `{ name, order, required, interpolate, text }` | `dsh-system-prompt/lib/index.js` 的 `context()` 实现 |
| context 的 `text(context)` **同步**调用 | 返回字符串；异步会拿到 Promise 对象 | `resolveContext()` 直接调用 `entry.text(context)` |
| `context` 参数含 `{ agent, scope, signal }` | 从中取 `context.agent.session` | `dsh-agent/lib/types/dispatch.js` 的 `assembleContextFor` |
| **每步会再调 `refreshContext()`** | 它会按 provider 重新解析每条 context，覆盖装配钩子里的改写 | `dsh-agent-loop/lib/index.js` 调用点；`dsh-system-prompt` 的 `refreshContext` |
| `await sessionProjections.register()` → `handle.stateOf(session)` | 等注册成功后才发布上下文、工具和成功标记；新宿主持有句柄；旧式返回值保留 registry `stateOf` 回退 | [0.2.2-rc.1 升级契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.1-rc.2/session-projection-handles/guide.md)；两个官方 CLI 的真实加载、读取、冷重放、拒绝和释放测试 |
| `session.append(..., {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]})` | 只替换旧运行时快照，替换消息须含`role:'user'`；过滤命名记忆节并保留其他来源，原始事件不删除 | 当前`dsh-session`协议及实际宿主请求探针 |
| `ctx.workingDirectory.get(session)` | 同步返回绝对路径 | `dsh-working-directory/lib/index.js` |
| `sessionQuery.observeSession(id,{projectionMode:"none"})` | 经异步读平面取得只读事件观察，用后释放`Symbol.dispose`，结合活动surface及`isOwnSeq`核对来源；缺服务无持久恢复保证 | 当前`dsh-session-query`观察租约实现；不新增调用已弃用同步原始事件读接口 |
| `ctx.inject(['sessionQuery'], callback)` | 可选服务的子作用域随提供方就绪/卸载而激活/释放；每代服务有独立取消信号，旧清理不得撤销新提供方。没有该API的上下文仅在使用点公开查询活动实现 | 官方服务/生命周期规范及宿主Cordis的inject API；v0.19实际暴露启动早于service就绪，v0.20修复 |
| `ctx.tools.register(definition)` | 只校验 `output.render` 与 `output.schema`，不需要 `defineTool` | `dsh-tools/lib/index.js` 的 `register()` |
| profile patch 的 `insert` 语义 | `- insert: [...]` 追加行；非 insert 补丁按 `id` 覆盖整行 `config` | `dsh-app-boot` 的 `applyEntryPatches` |
| preset 内的插件 config **不可**由 profile 补丁覆盖 | `buildMap` 只递归 `entry.group && Array.isArray(entry.config)` | 同上（实测：补丁只命中顶层那行） |

## 2.5 工具 schema 的硬规则（加载期校验）

宿主在**注册时**校验工具 schema，不合格会让整个插件加载失败（不是该工具不可用）。实测报错：

```
memory (file://…/index.mjs): JsonSchemaError: unsupported JSON schema:
schema.properties.byType.additionalProperties must be a boolean
```

规则：

1. `additionalProperties` 必须是**布尔值**，不能是 schema 对象
2. 每个 schema 节点必须有 `type`（或用 `oneOf`/`anyOf`）
3. `required` 里的字段必须出现在 `properties`
4. 本机输出schema不接受`maxItems`、`maxLength`、`pattern`等额外约束关键字；dev.12原生加载曾因此明确失败，原日志保留。认识层schema使用已支持子集，数量、长度、维度与凭据检查由插件的实际输入校验器执行。

`test/test-schema.mjs` 把这三条搬进测试；`scripts/probe-load.mjs` 用隔离实例验证真加载。

## 3. 运行时自检与降级

`apply()` 先跑 `selfCheck(ctx)`，按三级处理：

| 情况 | 行为 |
|---|---|
| `systemPrompt.context` 不是函数 | **抛错**（`宿主 API 不匹配`），让宿主把它记成加载失败，而不是静默不注入 |
| `workingDirectory.get` 不可用 | 降级：只注入全局库，项目库跳过 |
| `tools.register` 不可用 | 降级：不注册六个工具，注入照常 |

降级情况会写进 `.diag.json` 的 `degraded` 字段（需 `.diagnostics` 开关）。

## 4. 宿主升级后的复验步骤

```bash
# 1. 结构：宿主是否还提供这三个服务
node -e "console.log(require('fs').readFileSync('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/runtime.json','utf8'))"

# 2. 行为：跑单元测试（不需要宿主）
npm test

# 3. 评测：注入/逃逸/成本是否还达标
npm run gate

# 4. 真实加载：用一个隔离实例加载插件（不碰用户 profile）
node scripts/probe-load.mjs
#    真实 Session / Projection 注册和历史契约（合成输入、无模型调用）：
node scripts/probe-history.mjs
#    更严格的离线打包、全新 home 验证：node scripts/probe-package.mjs
#    成功标志：隔离目录的 .loaded.json 版本与六工具注册匹配

# 5. 端到端：重启桌面应用，node accept.mjs 应 9/9
```

## 5. 已知的版本敏感点

| 点 | 为什么会变 | 变了的症状 |
|---|---|---|
| `refreshContext` 覆盖行为 | 若某版改成"以装配钩子的结果为准"，当前写法仍正确（provider 才是真相源） | 无 |
| `assembleContextFor` 的字段 | 若 `context.agent` 改名，provider 会一直返回空串 | 注入块消失 |
| patch `insert` 语义 | 若改成合并 config，installer 仍兼容 | 无 |
| preset 的 `plugins` 结构 | 若改成 loader 子条目，profile 补丁就能覆盖 preset 内 config | 我们的 git 锚点方案可以退休 |

## 6. 不承诺的

- 0.1.x / 0.3.x 宿主：未验证。
- `headless` / `acp` / `sdk` profile：只验证了 `web` 与 `desktop`（两者同构：`dsh-base` + `dsh-web-app`）。

## 7. 项目身份与剩余风险

| 项目 | 说明 | 当前处理 |
|---|---|---|
| 旧路径slug碰撞 | `/x/A B`与`/x/A-B`会共享目录；不能假定用户实际路径永不碰撞 | v0.19按完整项目根路径哈希分库，旧库须本地双版本审查后复制，保留原内容；中断需显式恢复，不自动分配给先访问的项目。 |
| 通用读取的lstat→read窗口 | 现有通用读链尚未全面换成文件描述符检查 | 新迁移复制使用O_NOFOLLOW/O_NONBLOCK及fstat/路径身份复查；通用读链仍须另外验证，不能把局部修正当全仓已解决。 |
| 语义改写的记忆污染 | 气味检测在无偏留出集上 TPR 20% | 研究性问题；当前按「标记器」定位，不做超出证据的承诺。 |

## 7.5 自动捕获依赖的宿主能力（0.3.0）

| 依赖 | 用法 | 证据 |
|---|---|---|
| `ctx.on('session/event', (session, event) => …)` | 监听 `user/message` / `assistant/message` / `step/end` | `dsh-session` README：持久化插件就是订阅这条流 |
| `ctx.llm.prepareCall()` → `call.stream()` | 发起一次抽取请求 | `dsh-session-title-llm` 的写法 |
| `prepareCall(config,signal,configure)` | 在同一适配器注册/能力结果上同步选择控制值；支持off则关闭，否则省略并保留宿主默认；发送使用原准备句柄的完整配置，禁止再次覆盖effort | 本机SDK 0.2.1-rc.3的`dsh-llm`实现：回调先于默认值/能力校验，句柄一次派发且校验配置一致；未将独立能力查询当绑定保证 |
| 服务访问 | 必选依赖声明`inject`；可选服务优先用官方`ctx.get(name)`，只取活动实现。旧宿主/测试上下文才回退`reflect.get(name)`或已有属性，不用`strict=false`获取尚未活动的实现 | 官方services指南及本机Cordis的代理/ReflectService源码 |
| 路由 | **不要**依赖 `ctx.llm.listProviders()`：CLI 实例里它是空数组（适配器按会话注册）。改为监听会话的 `request/header` 事件，从 `data.header.config.{provider,model}` 取 | 真实会话日志实测该事件带 `provider: deepseek-account, model: deepseek-flash` |

拿不到 llm 时不注册监听，插件照常工作；配置里给了 `provider`/`model` 就优先用。

## 8. 与宿主对话压缩（compaction）的关系

DSH 自带对话压缩，桌面 profile 里启用的是这四个（`dsh-base/cordis.patch.yml`）：

| 插件 | 作用 |
|---|---|
| `dsh-compaction-basic` | token 压力上升时把最旧历史换成摘要（默认 `thresholdRatio 0.8`）；上下文溢出后压缩再重试 |
| `dsh-command-compact` | `/compact` 手动压缩，不占模型轮次 |
| `dsh-compaction-tool-result-pruner` | 先修剪超大工具结果（`thresholdChars 8192`，头 4096 / 尾 1024） |
| `dsh-compaction-image-offload` | 图片超预算时把最旧的换成占位符 |

官方文档明确写了它的边界：**"它无法缩减系统提示词、工具或会话前缀"**。

### 四个接触面，以及本插件怎么处理

| 接触面 | 会不会冲突 | 处理 |
|---|---|---|
| 运行时快照与压缩 | 快照会进入会话历史，可能被压缩；不能从provider重复渲染测试推断相反结论 | v0.11.0从当前库重建，按来源替换旧记忆节；既有普通摘要中的复述仍未清除。`test/test-compaction-compat.mjs`只验证provider和工具机制，实际请求另测 |
| 注入体积 | **压缩救不了它**，它是每步都要付的固定税 | 索引硬上限 300 行 / 25 KB（`LIMITS`）；测试断言 1000 条时注入仍 < 27 KB |
| 工具输出被修剪 | **会**——超过 8192 字符会在中间被截断，JSON 形状破坏 | search 输出 ≤4 KB；links 的入边/出边各截到 10 条并报总数；status < 2 KB |
| 压缩后模型忘记自己写过 | **会**导致重复写入 | 写入侧幂等（逐字重复 → `duplicate`）、相似度闸、冲突提示 |

### 命名

工具叫 `memory_prune` 而不是 `memory_compact`，避免与宿主 `/compact`（对话压缩）混淆。
`test/test-compaction-compat.mjs` 里有一条断言守着这个命名。

### 结论

两者是互补的，不是竞争关系：对话压缩丢掉的历史细节，正好靠记忆库 + `memory_search` 找回；
而记忆索引的固定成本，压缩帮不上忙，只能靠索引自身的上限控制。
