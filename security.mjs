/**
 * dsh-memory 的安全内核。纯函数 + 文件原语，不依赖宿主，便于单测。
 *
 * 设计依据：
 * - OWASP AISVS C2.1（2.1.1 归一化先于分词、2.1.2 编码走私检测、2.1.3 一切可影响
 *   模型行为的输入按不可信处理）
 * - MinJA / MemPoison：记忆污染可分 L1 单条、L2 组合、L3 上下文触发；写入时的
 *   静态过滤只压得住 L1，所以必须叠「出门侧」防护
 * - NemoClaw / Lasso：改写 agent 自己的记忆文件，能把一次性注入变成每次会话都
 *   复发的后门 —— 所以持久化的 markdown 必须当不可信内容处理
 * - SymJack：符号链接能让「读一个普通文件」变成读任意路径
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  chmodSync,
  writeFileSync,
  fsyncSync,
  appendFileSync,
  existsSync,
} from 'node:fs'
import {guardStoreLock} from './store-lock-guard.mjs'
import { join,resolve,dirname,basename } from 'node:path'
import {assertRestorationInactive} from './restoration-lock.mjs'
import { createHash, randomUUID } from 'node:crypto'

/** 记忆文件大小上限：超过就不读，避免一个坏文件把上下文撑爆。 */
export const MAX_SOURCE_BYTES = 512 * 1024

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

// ── 文本净化 ────────────────────────────────────────────────────────────────

/** 不可见字符：C0/C1 控制符（保留 \t \n）、零宽、双向覆盖、Unicode 标签块。 */
// 覆盖三类：
//   · C0/C1 控制符（保留 \t \n）
//   · 所有 Unicode 格式字符 (Cf)：零宽、软连字符 U+00AD、U+061C、双向覆盖、BOM…
//   · 组合用的不可见字符：CGJ U+034F、变体选择符 FE00–FE0F 与 E0100–E01EF、Unicode 标签块
// 之前漏了 Cf 与变体选择符，`<mem\u00ADory-store>` 能整段绕过中和（审计发现）。
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\p{Cf}|[\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|[\u{E0000}-\u{E007F}]/gu

/** 框架自己的定界符，出现在内容里就是注入尝试。 */
const FRAME_TOKENS = /<(\/?)(memory-store|system-reminder)/gi

/**
 * 注入前归一化：NFC + 去掉不可见字符。
 * 先归一化再判断，否则同形字/零宽能绕过任何后续规则（AISVS 2.1.1 的排序要求）。
 * @param text - 原始文本。
 * @returns 归一化后的文本。
 */
export function normalizeText(text) {
  // 只用 NFC，不用 NFKC。
  // NFKC 会把全角标点折成半角——中文内容里的「，」「：」「（）」会被悄悄改掉，
  // 对中文记忆库是破坏性的（这条是测试抓出来的：期望「，」实际得到「,」）。
  // 全角与同形字改用「仅检测时折叠」的方式处理，见 foldConfusables。
  return String(text).normalize('NFC').replace(INVISIBLE, '')
}

/** 与定界符字母形状相近的字符。只用于「检测」，不改变存储内容。 */
const CONFUSABLE = new Map(Object.entries({
  // 西里尔（补全 memory-store / system-reminder 里会用到的字母）
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ѕ': 's', 'ԁ': 'd',
  'м': 'm', 'т': 't', 'н': 'h', 'к': 'k', 'в': 'b', 'г': 'r', 'п': 'n', 'з': '3', 'ч': '4',
  'А': 'A', 'Е': 'E', 'О': 'O', 'Р': 'P', 'С': 'C', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ѕ': 'S',
  'М': 'M', 'Т': 'T', 'Н': 'H', 'К': 'K', 'В': 'B',
  // 希腊
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'τ': 't', 'υ': 'y', 'ς': 's', 'μ': 'm',
  'Α': 'A', 'Ε': 'E', 'Ο': 'O', 'Ρ': 'P', 'Ι': 'I', 'Τ': 'T', 'Υ': 'Y', 'Μ': 'M',
  // 常见拉丁变体
  'ⅼ': 'l', 'Ⅰ': 'I',
}))

/**
 * 把字符折叠成用于检测的 ASCII 形态。**只影响判断，不写回内容。**
 * 两层：全角 ASCII 区（U+FF01–FF5E 整体偏移 0xFEE0）+ 同形字表。
 */
function foldConfusables(text) {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0)
      continue
    }
    out += CONFUSABLE.get(ch) ?? ch
  }
  return out
}

/** 候选标签：半角或全角尖括号包裹，限长避免把整段文本当标签。 */
const TAG_CANDIDATE = /[<\uff1c][^<>\uff1c\uff1e\n]{1,200}[>\uff1e]/g

/**
 * 中和框架定界符，防止记忆内容提前闭合 `<memory-store>` 再假装成新的指令区。
 *
 * 两遍：
 *   1. 精确匹配（快路径）
 *   2. 候选标签按同形字折叠后判断——挡住 `<memоry-store>`（西里尔 о）这类变体
 *
 * @param text - 已归一化的文本。
 */
export function escapeFraming(text) {
  return text
    .replace(FRAME_TOKENS, (_match, slash, token) => `‹${slash}${token}`)
    .replace(TAG_CANDIDATE, (tag) => {
      // 先剥不可见字符再折叠：软连字符插在字母中间时，折叠前必须先去掉它
      const folded = foldConfusables(tag.replace(INVISIBLE, '')).toLowerCase()
      // 命中即把两端定界符都换成中性括号，且不改变标签内部原文
      return /^<\/?\s*(memory-store|system-reminder)\b/.test(folded) ? `‹${tag.slice(1, -1)}›` : tag
    })
}

/**
 * 统计文本里「看起来像」框架定界符的标签数（含同形字变体）。
 * 供评测判断一条 payload 是否真的越界，而不是只认 ASCII。
 * @param text - 待检测文本。
 */
export function countFrameTokens(text) {
  const folded = foldConfusables(String(text).replace(INVISIBLE, ''))
  return (folded.match(/<\/?\s*(memory-store|system-reminder)/gi) ?? []).length
}

/** 敏感信息模式。命中即拒绝写入；读出时则打码。 */
const SECRET_PATTERNS = [
  // anthropic 放在 openai 之前，且 openai 用负向前瞻排除 sk-ant-：
  // 否则 sk-ant-… 会被 openai 先吃掉，anthropic 这一类永远不生效（审计发现）
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_key', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ['google_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{20,}/g],
]

/**
 * 找出文本里的敏感信息。
 * @returns 命中的类别名数组（去重）。
 */
export function findSecrets(text) {
  const hits = new Set()
  for (const [name, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) hits.add(name)
  }
  return [...hits]
}

/**
 * 出门侧兜底：把已经躺在库里的敏感串打码。
 * 写入侧会拒绝，但历史数据、外部编辑、被污染的文件仍可能带进来。
 * @param text - 待注入文本。
 */
export function redactSecrets(text) {
  let out = text
  for (const [name, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, `[REDACTED:${name}]`)
  }
  return out
}

/**
 * 完整的内容净化链：归一化 → 打码 → 中和定界符。
 * 顺序有讲究：先归一化再匹配，否则同形字与零宽可以绕过模式。
 * @param text - 原始内容。
 */
export function sanitizeForInjection(text) {
  return escapeFraming(redactSecrets(normalizeText(text)))
}


// ── 指令气味（L2 组合污染的缓解层） ────────────────────────────────────────
//
// MemPoison 的结论：写时一致性检查只压得住 L1 单条腐化，压不住 L2 组合。
// 真实攻击往往由多条各自「看起来正常」的记录合起来构成指令。这里做的不是检测
// 攻击，而是给「像指令的文本」打标：命中劫持语义才标，普通祈使句（如「改稿要附说明」）
// 不标——记忆本来就是用来影响行为的，把规则当攻击会让这一层失效。

/**
 * 劫持语义按**技术类别**划分，不按句子打补丁。
 *
 * 强信号（2 分）：单独命中就该标记——它们描述的是攻击的意图，而不是措辞。
 * 弱信号（1 分）：单独出现很常见（正常记忆里就有 URL、就有"执行 npm test"），合并才标。
 *
 * 类别来源：OWASP AISVS C2.1 的攻击面描述 + MemPoison 的持久化污染。
 * 刻意不含「必须/务必/立刻」这类普通祈使词：记忆本来就是用来影响行为的。
 */
const META = '(instructions?|rules?|policy|policies|prompt|directives?|context|memory|guidance)'
const CMD_VERB =
  '(set\\s+aside|discard|ignore|forget|override|disregard|cancel+ed?|void|recite|reveal|print|show|output|adopt|behave|act|persist|store|save|record|hide|conceal|disclose|upload|post|send|spawn|invoke)'

const SMELL_PATTERNS = [
  // 结构规则：元术语与命令动词在 40 字符内共现。不依赖具体句式，
  // 这样 "Set aside every earlier directive" / "Discard your operating rules"
  // 这类没见过的说法也能命中。
  ['meta-directive', 2, new RegExp(`${META}[^.]{0,40}\\b${CMD_VERB}\\b|\\b${CMD_VERB}\\b[^.]{0,40}${META}`, 'i')],
  // 中文同构：动宾结构里的"规则/指令/提示词"
  ['meta-directive-zh', 2, /(规则|指令|提示词|策略)[^。；]{0,20}(作废|失效|无效|重写|覆盖|丢弃|绕过)|(忽略|无视|忘掉|丢弃|绕过|重写)[^。；]{0,12}(规则|指令|提示词|策略|以上|上文|前述|前面)|(输出|打印|显示)[^。；]{0,6}(系统提示|提示词)|跳过[^。；]{0,6}(安全|检查|限制|校验)/i],
  // 上下文重置：不点名「规则」，只指向上文——"Forget everything above" 这类
  ['context-reset', 2, /(ignore|forget|discard|disregard|set\s+aside)\s+(\w+\s+){0,2}(above|previous|earlier|prior|everything|what\s+came\s+before)/i],
  // 角色/身份切换
  ['role-shift', 2, /(behave|act|respond|answer|reply)\s+as\s+(an?\s+)?(unconstrained|unrestricted|unfiltered|different|admin|root|system)|from\s+(this\s+point|now\s+on|here\s+on)\s+you\s+(are|will)|adopt\s+the\s+(persona|role|identity)|take\s+on\s+the\s+role|pretend\s+to\s+be|you\s+are\s+now|你现在是|从现在起你|扮演|假装你是/i],
  // 对用户/操作者隐瞒
  ['concealment', 2, /(keep\s+this\s+between|never\s+(surface|reveal|mention))|(do\s+not|don'?t|hide|conceal)\s+(disclose|reveal|mention|tell|hide)?[^.]{0,30}\b(operator|human|user|owner)\b|(不要|别)(向)?(用户)?(告诉|提及|透露|暴露|报告|汇报|上报)[^，。；]{0,10}(指令|提示词|规则|这次|以上|此事|操作)/i],
  // 把行为写死到未来（持久化污染）
  ['persistence', 2, /(persist|store|remember|save|record)\s+(the\s+following|this)|for\s+(every|all|each)\s+(future\s+)?(repl(y|ies)|answer|response)|(when|whenever)\s+(asked|you\s+are\s+asked)[^.]{0,40}(answer|respond|say|reply)|永久记住|以后一律|每次都要回答/i],
  // 伪造边界或新指令头
  ['boundary-forgery', 2, /(end|end\s+of)\s+(the\s+)?(memory|context|instructions)|(new|begin)\s+(system\s+)?(instructions?|directives?)\s+(follow|below|begin|:)|-{2,}\s*new\s+instructions?|system\s+override/i],
  // 分步诱导：先读/先执行，再外带
  ['staged', 2, /(first|before\s+(answering|responding)|then|after\s+that)[^.]{0,40}(read|open|run|execute|paste|curl|cat)|先[^。；]{0,20}(读取|执行|运行|发送)/i],
  // 编码后执行
  ['encoded-instruction', 2, /(decode|unscramble|deobfuscate|decrypt)[^.]{0,30}(obey|follow|perform|execute|act)/i],
  // 把数据搬出去
  ['data-transfer', 2, /(post|upload|send)\s+(\w+\s+){0,3}(archive|snapshot|file|workspace|repository|contents|dump|secrets?)/i],
  // 起 shell / 子进程
  ['shell-exec', 2, /(invoke|spawn|launch)\s+(a\s+)?(subprocess|shell|command|child\s+process)|dump\s+the\s+env/i],
  // 伪造工具调用
  ['tool-spoof', 2, /\{\s*"(name|tool)"\s*:|<tool_(call|use)>|functions\.|assistant\s+to=/i],
  // —— 以下为弱信号：单独出现很常见 ——
  ['privilege', 1, /sudo|root\s+access|admin\s+rights|no\s+restrictions|unrestricted\s+mode|无限制模式|管理员权限|越狱/i],
  ['exfil', 1, /curl\s|wget\s|https?:\/\/|webhook|base64\s|exfiltrat|上传到|发送到/i],
  ['credential-path', 1, /~\/\.ssh|id_rsa|\/etc\/(passwd|shadow)|\.env\b|api[_-]?key|environment\s+variables?/i],
]

/**
 * 给一段文本打「指令气味」分。
 * 按权重累加、每类只计一次：同类里堆十个词不等于更像攻击。
 * @param text - 待评估文本。
 * @returns `{ score, hits }`。
 */
export function instructionSmell(text) {
  const hits = []
  let score = 0
  for (const [name, weight, pattern] of SMELL_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      hits.push(name)
      score += weight
    }
  }
  return { score, hits }
}

/** 超过阈值即视为可疑。 */
export function isSmelly(text, threshold = SMELL_THRESHOLD) {
  return instructionSmell(text).score >= threshold
}

/** 默认阈值：加权 2 分以上才标记。弱信号单独出现太常见，标了等于没标。 */
export const SMELL_THRESHOLD = 2

// ── 文件原语 ────────────────────────────────────────────────────────────────

/** 同步睡眠，用于锁重试。宿主是单线程事件循环，这里只在写路径上短暂占用。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 只接受普通文件。符号链接可能指向记忆库之外（SymJack 的教训），
 * 目录、设备、FIFO 一律拒绝。
 * @returns 文件存在且安全时为 true；不存在时为 false。
 * @throws 路径是符号链接或非普通文件时。
 */
export function assertRegularFile(file, maxBytes = MAX_SOURCE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) throw new Error('invalid-file-read-limit')
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`拒绝符号链接：${file}（可能指向记忆库之外）`)
  }
  if (!stat.isFile()) {
    throw new Error(`拒绝非普通文件：${file}`)
  }
  if (stat.size > maxBytes) {
    throw new Error(`文件过大：${file}（${stat.size} 字节，上限 ${maxBytes}）`)
  }
  return true
}

/**
 * 读一个可信路径下的文本。安全检查失败时抛错，由调用方决定降级。
 * @returns 内容；文件不存在时返回 undefined。
 */
export function readSafely(file, { maxBytes = MAX_SOURCE_BYTES } = {}) {
  if (!assertRegularFile(file, maxBytes)) return undefined
  return readFileSync(file, 'utf8')
}

/**
 * 建目录并收紧权限（0600 的文件放 0700 的目录里）。
 *
 * 只收紧、不放开：如果目录已存在且属主主动去掉了写权限（0500），那是用户的意图——
 * 冻结记忆库、或安全工具在隔离现场——插件不该把它改回可写。此时写入会拿到
 * EACCES，这才是正确行为。
 */
export function ensureStoreDir(dir) {
  if (existsSync(dir)) {
    try {
      const mode = statSync(dir).mode & 0o777
      // 只有组/其他人有权限时才收紧；缺 owner-write 的情况保持原样
      if ((mode & 0o077) !== 0) chmodSync(dir, DIR_MODE)
    } catch {
      /* 收紧失败不阻断写入，交给验收检查暴露 */
    }
    return
  }
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try {
    chmodSync(dir, DIR_MODE)
  } catch {
    /* 同上 */
  }
}

/**
 * 原子写：同目录临时文件 → rename。临时文件先建成 0600，避免短暂的可读窗口。
 * @param file - 目标文件。
 * @param text - 内容。
 */
export function writeSafely(file, text) {
  ensureStoreDir(join(file, '..'))
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(temp, 'wx', FILE_MODE)
  try {
    try {
      writeFileSync(fd, text, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* preserve original error */ }
    throw error
  }
  try {
    chmodSync(file, FILE_MODE)
  } catch {
    /* 同上 */
  }
}

/**
 * 写-改-写互斥。两个会话同时写同一份索引会丢更新，所以整段读改写要加锁。
 * 锁文件用 O_EXCL 创建；超过 staleMs 的锁视为主人已死，回收。
 * @param dir - 记忆库目录。
 * @param fn - 临界区。
 * @param options - 超时与过期阈值。
 */
function withLocalLock(dir, fn, options = {}) {
  const { timeoutMs = 3000, staleMs = 15000, allowPublication = false } = options
  ensureStoreDir(dir)
  const lock = join(dir, '.write.lock')
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const start = Date.now()

  for (;;) {
    try {
      const fd = openSync(lock, 'wx', FILE_MODE)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }), 'utf8')
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          // compare-and-delete：只删自己刚读到的那把锁。
          // 无条件 unlink 会在 A「删旧锁→建新锁」的间隙删掉 A 的新锁（审计发现的级联竞态）。
          const seen = readFileSync(lock, 'utf8')
          if (statSync(lock).mtimeMs <= Date.now() - staleMs && readFileSync(lock, 'utf8') === seen) {
            unlinkSync(lock)
          }
          continue
        }
      } catch {
        /* 锁刚被别人删掉，重试即可 */
      }
      if (Date.now() - start > timeoutMs) {
        const error = new Error(`记忆库正被另一个写入占用（${lock}），请稍后重试`)
        error.code = 'memory-lock-busy'
        throw error
      }
      sleepSync(25)
    }
  }

  try {
    if (!allowPublication && existsSync(join(dir, '.publication.json'))) throw new Error('publication-needs-recovery')
    return fn()
  } finally {
    try {
      // 只释放自己的锁：万一已被别人回收并重建，不能删别人的
      if (JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock)
    } catch {
      /* 锁已不存在或不是自己的，不再处理 */
    }
  }
}

// ── 审计 ────────────────────────────────────────────────────────────────────

const AUDIT_MAX_BYTES = 1024 * 1024

/**
 * 追加一条审计记录。工业系统的要求不是「有日志」，而是「操作可追溯」：
 * 谁在什么时候、对哪个作用域、做了哪种操作、结果如何。
 * @param dir - 记忆库目录。
 * @param entry - 操作描述。
 */
export function appendJsonl(dir, filename, entry) {
  try {
    ensureStoreDir(dir)
    const file = join(dir, filename)
    if (existsSync(file)) {
      // 写路径同样拒绝符号链接：读路径早就校验了，追加这边之前漏了
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`拒绝写入非普通文件：${file}`)
      }
      if (stat.size > AUDIT_MAX_BYTES) renameSync(file, `${file}.1`)
    }
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })
    appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: FILE_MODE })
  } catch {
    /* 写日志失败不影响主流程 */
  }
}

/** 操作账本：谁、在哪个会话、做了什么、结果如何。 */
export function appendAudit(dir, entry) {
  appendJsonl(dir, '.audit.jsonl', entry)
}

/**
 * 历史链：被取代或被删除的条目原文。
 * 审计回答「做过什么」，历史回答「原来是什么」——两者不能互相替代。
 */
export function appendHistory(dir, entry) {
  appendJsonl(dir, '.history.jsonl', entry)
}

/**
 * 条目 id：内容寻址（sha1 前 8 位）。
 *
 * 不引入 id 列、不改索引格式：一行索引的 id 就是它当前内容的哈希。
 * 好处是历史日志可以自证——重算一遍就能验证某条记录在写入时确实是那个内容。
 * 代价是「改一个字就换 id」，但这正是我们想要的语义：改动等于取代。
 *
 * @param line - 索引行原文（已归一化）。
 * @returns 8 位十六进制 id。
 */
export function entryId(line) {
  return createHash('sha1').update(String(line), 'utf8').digest('hex').slice(0, 8)
}

/**
 * 注入前的结构自检：一段文本里还剩下几个「像框架定界符」的标签。
 *
 * 为什么需要它：`countFrameTokens` 之前只在测试与评测里调用，生产路径从不自检，
 * 于是「中和是否真的生效」没有任何运行时保证——独立审计正是靠这一点找到 5 类绕过的。
 *
 * @param text - 即将进入上下文的文本。
 * @returns `{ ok, tokens }`；`ok` 为 false 表示中和漏了。
 */
export function frameIntegrity(text) {
  const tokens = countFrameTokens(text)
  return { ok: tokens === 0, tokens }
}

export function withLock(dir,fn,options={}) { const p=resolve(dir);assertRestorationInactive(basename(dirname(p))==='projects'?dirname(dirname(p)):p);return guardStoreLock(dir,()=>withLocalLock(dir,fn,options)) }
