# 闲置记忆复核

SoloPup 可以在 DSH 闲置时复核你选定的项目。比如，你先记了“报告交付用纯文本”，后来明确改成 PDF。下一次复核会把两处原话和修改建议放进报告，供你核对。正式项目记忆的更改仍走日常的记忆写入和确认流程。

## 用普通 DSH 开启

功能默认关闭。使用支持插件配置的 DSH，在当前 profile 的 `cordis.patch.yml` 中配置 `memory` 行。把示例中的绝对路径和模型标识换成自己的项目与已配置模型。已有 `autoCapture` 设置时，一起保留在同一个 `config` 下。

```yaml
- id: memory
  config:
    dream:
      enabled: true
      projects:
        - /absolute/path/to/project
      provider: your-provider-id
      model: your-model-id
```

默认前台连续闲置 20 分钟后检查，每天最多 2 次模型派发，共用 12,000 token 预算。每次复核使用一个选定项目的现行记录和有限的来源片段。DSH 需要保持运行。新一轮前台交互会中断正在进行的后台复核，待下次满足条件再检查。

用项目里的新会话说「帮我打开最新的做梦报告」。`memory_dream_report` 会重新核对报告引用的来源，显示仍有效的原话。来源已撤回、替换或无法核对时，对应建议和原话会隐藏。可以用下面的方式明确指出要复核的旧约定，其中引号内应匹配当前的一条记忆。

> 更正「报告交付用纯文本」：今后报告统一用 PDF。

可以在已安装插件的目录下执行 `node scripts/dream-review.mjs status` 查看运行状态，或执行 `node scripts/dream-review.mjs reports` 查看报告编号。命令行 `show` 只能核对本地记忆库可验证的来源。涉及 DSH 历史会话的原话需要在对应项目的 DSH 会话内查看。关闭自动复核时，把 `enabled` 改回 `false` 并重新加载配置。

如果后台请求断开且无法确认模型端结果，队列会停在 `uncertain`。需要继续复核其他批次时，可以用 `node scripts/dream-review.mjs abandon RUN_ID` 放弃该结果。该批次的预算仍按预留额记账，系统也不会重发同一批次。放弃只是本地队列操作，服务商是否已经收到或完成请求仍以其回执为准。

## 使用实验性的 Super Agent 模式

已验证的环境是 macOS、DSH 0.2.2-rc.1 和 Super Agent 原型提交 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。Super Agent Worker 负责执行同一种复核，SoloPup 保存队列、证据规则和报告。主进程持有模型连接，Worker 的运行环境仅获得本次任务的输入和必要的运行文件。

将 [Super Agent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 签出到上述提交，在该目录运行 `pnpm install --frozen-lockfile --ignore-scripts`。回到 SoloPup 安装目录，运行 `node scripts/dream-companion-build.mjs /absolute/path/to/dsh-superagent-prototype`。记录命令返回的 bundle 路径和 SHA-256。把下列配置追加到同一个 DSH profile，替换其中的绝对路径和 SHA-256。

```yaml
- insert:
    - id: solopup-dream-companion
      name: file:///absolute/path/to/solopup-memory/scripts/dream-companion-plugin.mjs
      config:
        dshCli: /absolute/path/to/dsh
        prototypeBundle: /absolute/path/to/solopup-dream-prototype.mjs
        prototypeBundleSha256: replace-with-the-build-sha256
        stateDir: /absolute/path/to/solopup-dream-companion-state
```

重新加载 DSH 后，在已安装插件目录中运行 `node scripts/dream-review.mjs mode superagent`。当前任务完成后才切换，下一个任务使用新模式。可以运行 `node scripts/dream-review.mjs mode ordinary` 切回。两种模式共用报告、队列和预算。准备卸载伴随服务时，先切回普通模式，并确认 `status` 显示切换已完成。如果已选的 Super Agent 服务突然不可用，状态会显示不可用，待你恢复服务或主动切回普通模式。
