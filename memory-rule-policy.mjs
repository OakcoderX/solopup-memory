/** Language guidance only. Capture actions and validation votes are separate roles. */
const COMMON=[
 '整段用户来源共同约束候选。逐条检查全部owner消息，不只核对候选自己选中的引文；后一条否定、纠正或例外也约束前一条规则。仅引用一般规则，不能忽略同窗明确的排除。',
 '区分默认偏好、明确排除和兼容补充。“通常、希望、偏好”不自动变成“总是、必须、仅限”；特殊情境中增加一项要求，不自动取消一般顺序或数量。只有原话明确说该情境不采用一般规则、改用另一规则，才给一般规则增加except。不要凭主题相关发明例外。',
 '一般规则和特殊要求都要保留。涉及同一反馈行为时，共有task=review条件应在相关分支一致；特殊分支再加原话给出的情境。独立身份、搭档和分工是claim，不继承反馈任务或听众条件。',
 'conditions为AND，except为OR；同一个dimension=value不能既是必须条件又是排除条件，否则该记录永远不适用。复合AND例外不能拆为OR。完整文档类别可用单一值document_kind=exploratory_draft；分支使用一致值。无法忠实表达时不伪造结构。',
 '当前scope、条件、期限及内容已正确时，仅确认“其他项目也一样”、同义改写或重复原话，不是新增信息。独立新要求可追加，即使与旧记录具有相同的scope、kind及conditions，也不能仅凭元数据相同认作重复。',
 '同一约定真的改值或改边界时，应指定同scope唯一现行目标。value只改取值并保留旧元数据；replace完整重述须由本轮真实owner来源支持全部新内容。旧解释不是新用户证据。互补分支及兼容补充无须互相取代。'
].join('\n')
export const RULE_CAPTURE_POLICY=COMMON+'\n先读完整来源窗口，把明确取代一般流程的特殊情境写入一般规则的except，再保存受该情境限定的特殊要求；两分支各自要引用足以支持自身的真实消息。不要只把否定写在特殊摘要而让一般结构仍无例外。最后再逐条回看所有用户消息。先对照现行记忆决定操作，再提取：正确旧规则的确认返回空数组；缺失的一般规则仍须补记，已正确保存的特殊要求不重复追加。确实修改同一规则时给supersedes；真正独立的新信息才追加。detail可省略，不编造允许项目例外等额外授权。'
export const RULE_VALIDATION_POLICY=COMMON+'\n先检验适用范围是否过宽：只要任一显示的用户原话明确说某情境不采用候选行为，而该候选的conditions/except仍允许该情境，applicability就是unsupported；不能假定别条特殊记忆会自动抵消本条结构。即使currentMemory为空也一样。然后检查currentMemory.operation中的拟议效果：append意味着所有旧行仍保留；若只是确认已正确保存的同一要求，另存同义副本的transition为unsupported。replace要核对是否只替换同一命题。sameMetadataRecordIds只代表元数据相同，不证明内容重复，不能以此拒绝独立新信息。对照完整原话再分别判断wording、applicability和transition；不替候选补造分支。'
