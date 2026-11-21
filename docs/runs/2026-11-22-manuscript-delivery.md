# 选稿和文件末行的六项对照

普通会话明确选择审读稿时，0.26.0-beta.2 仍把这份稿本的约定标为条件待核对。0.26.0-beta.3 在同一条件下将它列为适用。两个版本都查到了作者当初的交付约定。差别出现在下一步，beta.3 能读取约定绑定的 Markdown 文件，并指出末句之后还有一条备注。

| 预先固定的问题 | 0.26.0-beta.2 | 0.26.0-beta.3 |
| --- | --- | --- |
| 作者首行明确选审读版 | 仍待核对 | 审读版约定适用 |
| 作者只在比较两稿 | 待核对 | 待核对 |
| 作者明确选主稿 | 现行约定段中没有审读版规则 | 现行约定段中没有审读版规则 |
| 终稿在指定末句后又加了备注 | 查回原约定，没有独立文件核验结果 | 读回终稿，报告不符 |
| 把备注移到末句之前，再核验 | 查回原约定，没有独立文件核验结果 | 改前不符，改后吻合，文件指纹改变 |
| 另一份同名备稿正确，目标终稿仍错 | 查回原约定，没有独立文件核验结果 | 绑定的终稿仍不符 |

对照各用一次固定输入。旧版有两项给出预期结果，一项判断错误，三项无法给出独立核验结果。候选版六项均给出预期结果。两组没有声称模型写错或写对文件。文件内容由实验写入，模型响应由本机脚本固定，以便直接观察真实 DSH 发出的请求、搜索返回的记录 ID，以及 DSH 实际执行的工具结果。主稿项检查的是现行约定段中有没有错用审读版规则。

两组使用同一台 Mac 上的 DSH 0.2.2-rc.3、独立配置、相同的已初始化 Git 的项目文件夹和事先保存的作者约定。实验从已保存的项目决定开始，对照不测首次采集、模型是否主动调用工具、写作质量或 Super Agent Worker。真实 Flash 尝试在独立 profile 返回 `ACCOUNT_SIGN_IN_REQUIRED`。这个步骤没有产生模型交稿成绩。历史公开文字任务分数另见[原始 12 题报告](2026-11-20-frontiermemory-text.md)。

另用最终包在一个普通小说文件夹重复相同六项，六项均符合预期。安装前后和七次新会话前后，共 16 次核对文件夹及全部上级目录没有 Git 元数据。这项检查沿用已保存的项目约定。[普通文件夹回执](../../eval/memory-delivery/manuscript/plain-folder.json)

## 从作者原话写入

另做了一次从空库开始的检查。第一轮普通 DSH 会话只收到作者完整原话，原生写入及其来源审核完成后返回 `recorded`。第二轮查回同一项目记录 ID，从实际终稿得到 `mismatch`；修稿后，第三轮查回同一记录，得到 `matched` 和新文件指纹。三次会话均使用本地固定模型响应，其中包括工具选择和来源审核。此项独立于上表六项。[空库运行器](../../eval/memory-delivery/manuscript/native-author-write.mjs) · [空库回执](../../eval/memory-delivery/manuscript/author-write.json)

## 读取同一份索引需要多久

使用 DSH 随附的 Node 24.21.0，在同一台 Mac 将两个固定归档交替运行三轮（AB、BA、AB）。每轮每个索引规模采 50 次。300 条时，旧版三轮的中位数分别为 6.100、5.664、5.732 毫秒，新版为 3.223、3.055、3.088 毫秒。三轮再取中位数，**从 5.732 降至 3.088 毫秒，下降 46.1%**。10、50、150、300 条的注入字节数和目标条目可见性均一致。变化来自同一次读取中共享事务及原始记录，在下次读取时重新校验项目和撤回状态。较早的开发包在同时运行全量测试时另测得 6.536 毫秒。本地 5 毫秒门槛保持原值。上述数字只描述记忆上下文渲染。[独占测量的全部样本](../../eval/memory-delivery/manuscript/render-paired.json) · [并发负载样本](../../eval/memory-delivery/manuscript/render-concurrent.json)

## 在真实 DSH 上重试 Super Agent

旧版在 DSH 0.2.2-rc.3 的两项独立 Worker 检查都停在派单之前。原因是旧版只识别 rc.1 的宿主身份。新版识别 rc.3，并把这次实际运行的宿主文件、Worker 和进程隔离证明绑定到同一张回执。升级前留下的旧身份回执保留为待核实，重启后也不会据此重复派单。

在同一台 Mac 上重建固定提交的上游 Super Agent，得到与历史原型完全相同的归档指纹。普通做梦与独立 Worker 收到相同的两批冻结请求；另一次独立检查观察到 Worker 被实际调起、调用以及取消和重启后的任务状态。两项均通过。其余四项分别检查上游 Engine 接单、macOS 进程隔离、历史原话回读和普通做梦，也都通过。源码共发现 1,134 项测试，其中 1,128 项通过，其余六项按环境条件单独运行。这里用的是真实宿主和固定模型响应。本轮实际安装的是 rc.3。[六项宿主回执及旧版失败原因](../../eval/memory-delivery/manuscript/optional-host.json)

从最终归档重新安装后，完整回归和长历史压缩回放均通过。另用两次安装重启检查了数据保留、进程异常退出后的恢复，以及两个独立宿主同时运行。发布归档的 SHA-256 为 `138cf332a20eb5beac62aaa370bd9f5e049963bf101bcd81b5b18cbf1861f923`。

## 复跑

在装有相同 macOS DSH 客户端的机器上，从仓库根目录对两个发布归档分别运行下面的命令。用各自 GitHub Release 所附 `SHA256SUMS` 中的哈希。验证脚本会核对语料指纹、归档指纹、实际项目记录 ID、文件的相对路径和内容哈希。

```sh
node eval/memory-delivery/manuscript/compare.mjs ARCHIVE VERSION SHA256 OUTPUT_JSON eval/memory-delivery/prepare-arm.mjs
```

[冻结输入](../../eval/memory-delivery/manuscript/固定输入.json) · [公共运行器](../../eval/memory-delivery/manuscript/compare.mjs) · [前版回执](../../eval/memory-delivery/manuscript/beta2.json) · [新版回执](../../eval/memory-delivery/manuscript/beta3.json)

## English

Both packages retrieved the saved project agreement. With an explicit draft selection, beta.2 still left the reading-copy convention unresolved. Beta.3 marked it applicable. The newer package also inspected the named output file and distinguished a correct last line, an appended editorial note, and a correct line in the wrong file. The six observations above measure rule selection and file inspection in the real DSH host with scripted model responses and preloaded decisions. They do not measure autonomous manuscript delivery or a public benchmark score.
