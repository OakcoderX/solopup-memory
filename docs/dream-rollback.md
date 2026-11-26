# 0.27 做梦队列回退与返回

0.27 的做梦队列为 v5，0.26 的队列只接受 v4。不要让 0.26 打开 v5，也不要删除队列来绕过错误：队列包含报告、每日预算、未确认的请求和应用回执。常规 memory 快照只覆盖 data、control 和 binding，**不包含整个 `memory.dream` 目录**。

以下操作仅适合本机单写入者，必须先退出所有使用同一记忆库的 DSH、插件进程及命令行工具，确认没有后台写入。`--offline-dream-disabled` 是操作者对这两个条件的确认，脚本不能检测所有进程、其他机器或远端任务。所有涉及此记忆库的 profile 都必须明确将 `dream.enabled` 设为 `false`，包括 0.26 使用的配置，且保持关闭直到重新挂回；仅关闭 `autoApply` 不够。退出前保存配置，重新启动后核实设置。不要手动执行做梦或创建新队列。

1. 使用现有离线备份功能备份并验证记忆库（data、control、binding）。另行安全备份完整的 `memory.dream` 目录，保护其中可能存在的私有来源片段。保留这份备份，不要把备份当作日后自动恢复的当前状态。
2. 在 0.27 插件目录，使用实际记忆根路径执行：

   ```sh
   node scripts/dream-park.mjs park /absolute/path/to/memory --offline-dream-disabled
   ```

   脚本将整个 `memory.dream` 改名为 `memory.dream.parked`。若已有停放目录或 SQLite 日志文件，命令拒绝执行。已准备但未派发的批次会取消；派发中或运行中的批次标为 `uncertain`，保留预算，不会自动重发。已排队但尚未认领的批次仍保留。远端任务可能仍在运行，停放并不取消它。
3. 安装并运行 0.26，所有 profile 的 `dream.enabled` 持续为 `false`。不要创建新的 `memory.dream`。原本已有的现行记忆和撤回状态留在当前记忆库中，别用升级前快照覆盖回退期间的新修改。0.26 不提供 0.27 的自动应用功能；具体记忆格式兼容性应另行核对。
4. 返回 0.27 前，再次退出所有相关进程，保持 Dream 关闭并备份当下记忆库。运行：

   ```sh
   node scripts/dream-park.mjs reattach /absolute/path/to/memory --offline-dream-disabled
   ```

   如果 `memory.dream` 已存在，命令拒绝覆盖。先检查它的来源并保全，不能删除或合并后假称预算连续。恢复后先检查状态和报告、现行记忆及撤回来源是否正确，再由用户决定是否重新启用 Dream。`uncertain` 必须按正常流程核实或明确放弃，放弃仍保留预留预算。恢复排队工作会在重新启用后继续，按当前证据重新检查；不要把旧报告当作当前来源有效的证明。

操作被中断时先保持所有进程停止，检查 `memory.dream` 和 `memory.dream.parked` 哪个存在，不要重复创建。脚本只做本机停放，不是远端取消或完整备份方案；若两者都存在，保留两份并人工处理。
