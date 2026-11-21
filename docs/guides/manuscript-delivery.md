# 选对稿本，核对交付文件

假设你在同一个项目里写主稿和审读稿。你已经保存一条项目约定，含有条件 `edition=审读版`。新会话开始工作时，可以发下面这条消息。第一行单独写选稿声明，留一个空行再交代任务。

```text
本轮稿本：审读版

请继续第七章。
```

这个选择影响当前普通会话的这一轮。单纯讨论两种稿本会保留“条件待核对”。下一轮可以重新选择。跨会话保存采用的来源稿和章节，使用已有的[章节绑定](markdown-reference.md)。

如果你要求一个文件必须以某句原话结束，可以把下面这行单独发给 DSH，作为项目决定保存。文件名相对于项目根目录，标点和引号内的文字须准确。先确认记忆已保存或采纳。

```text
交付约定：终稿.md 的最后一行必须是「灯灭了。」
```

在同一项目让 DSH 查这条决定，并用 `memory_check_delivery` 核对。它用 `memory_search` 返回的完整记录 ID，重新读取作者指定的文件。末句之后还有审读备注时会返回 `mismatch`。把备注移到前面后再查，才能得到 `matched`。结果带相对路径和本次文件的 SHA-256 指纹。文件之后有改动，就需要再查一次。一个换行符可以结束末行，再多一个空白行或末尾空格都会影响精确匹配。

工具适用于普通会话中已保存的项目 Markdown 末行约定，要求保存时的原话与整条来源消息吻合。已有记忆沿用原版本记录的来源归属。来源稿、输出稿可以是不同文件。一次工具核验只说明末行是否吻合。读不到文件、没有选定适用稿本、约定已撤回等情形会给出相应状态。普通会话的收尾提醒仍由宿主按条件触发，用户也可以主动要求核验。

## English

For a saved project rule with the condition `edition=review`, start a normal DSH turn with `Current edition: review`. Leave a blank line and write the task below. The choice applies to this turn. You can discuss other drafts without selecting them.

Send this exact line as its own message to establish a project delivery rule, and confirm that the project decision was saved or adopted.

```text
Delivery rule: the last line of final.md must be "Lights out."
```

Ask DSH to find the saved decision and check the file. `memory_check_delivery` accepts its full record ID. Old decisions retain the source attribution saved by the version that recorded them. The tool reads the project-relative Markdown file and returns `matched` or `mismatch` with the SHA-256 digest of that revision. A note or a blank line after “Lights out.” fails the check. Run it again after an edit. Missing files, unavailable decisions and unresolved conditions have their own outcomes.
