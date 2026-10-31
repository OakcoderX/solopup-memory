import {RULE_CAPTURE_POLICY} from './memory-rule-policy.mjs'
import {MEMORY_SCOPE_POLICY} from './memory-scope-policy.mjs'
/** Shared model guidance, not a semantic validator or source of authority. */
export const TEXT_MEMORY_POLICY = [
 MEMORY_SCOPE_POLICY,
 RULE_CAPTURE_POLICY,
 '先判断以后是否仍有复用价值，再判断类型和条件。只记持久信息，不把这一轮的执行限制变成长期项目决定。',
 '“本轮不写文件、不重写正文、不做付费实验”只管本次操作，不记；“这个项目后续各集统一第三人称”才是持续的项目决定。若同句混有长期判断与一次性限制，分别处理，只保留长期部分。',
 '主体和适用条件不同：“我的固定搭档林舟负责声音，我负责剪辑”是claim，主体、搭档和分工写summary，conditions为空；不把“用户本人”写成audience条件，不把搭档和分工写成collaboration条件。',
 '“签收文档常用署名为海棠”是关于署名的claim，conditions为空；“给儿童讲解时先举例”才是preference，conditions可以是audience=children。项目归属由scope表达，不重复造project或owner条件。',
 'conditions/except只表达原话明确给出的情境限制，不重复命题内容、主体、来源、未核实状态或当前查询任务。没有这类限制就留空，不为显得结构完整而发明条件。',
 '摘要中的适用情境也要写进结构：反馈/评审时的顺序用task=review，只有初稿使用的标记用document_kind=draft；不能摘要写“初稿限定”而conditions为空或细节声称无条件。不得在细节中增加用户没规定的要求。',
 'detail可省略：只保留原话支持、以后可复用且摘要没有表达的信息。不要重复摘要、讲述记录过程，或自行补充例子、文件类别和新要求；这些扩写也必须逐句通过来源检查。',
 '固定署名、长期搭档和个人分工通常属于global；在某项目对话提到不等于仅限该项目。只有原话明确限定项目或临时协作才缩小范围。个人事实的年份、地点等背景不自动成为使用记忆时必须精确匹配的conditions；不要把“今年一直保持”变成需要查询者猜年份的time条件。',
 '用户只是澄清某条既有规则的边界时，更新那条规则并保留实际条件，不为每次澄清额外造一条价值观或决定；明确要求通用推理方法时仍可独立记为方法偏好。',
 '关于用户的belief只保留用户明确给出的竞争解释。模型补充的新原因不能放入有效的用户信念；可在本轮建议，或由后台以basis=inferred进入待审候选，不当成用户已经持有。待检验条件仍不得冒充已经观察到的结果。',
 '方法偏好与内容口味不同：“别从一次阅读选择推断我的长期叙述口味”是推理方法要求；不能由它记成长期喜欢第一人称。未做控制变量对照的原因解释仍是belief，保留已明确的竞争解释和可推翻条件。',
].join('\n')
