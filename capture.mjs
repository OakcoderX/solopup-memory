/**
 * 自动捕获：从用户消息里认出「值得记」的句子。
 *
 * 为什么需要它：实测 222 个会话里模型只主动调用过 2 次 memory_write。
 * 靠模型自觉写记忆这条路是死的，必须有确定性捕获。
 *
 * 设计取舍：
 *   · 只从**用户**消息里抓。模型的推断不该自动变成长期记忆。
 *   · 只抓「纠正 / 偏好 / 定论」三类——这三类错一次会一直错。
 *   · 纯规则，不调模型：可离线复算、可解释、零成本。
 *   · 抓到的先落 inbox，强信号直接入库，弱信号留给模型确认。
 */

import { findSecrets, normalizeText } from './security.mjs'

/**
 * 只有「持久性措辞」才算候选。
 *
 * 第一版用了「不要 / 别 / 不对」这类通用纠正词，离线复算 330 条用户消息里命中 191 条——
 * 「不要写文件」这种一次性任务指令被当成长期偏好。精度太差，自动入库会立刻污染记忆。
 * 现在只认明确指向「以后/长期」的措辞。
 */
const STRICT = [
  // 显式的记忆请求
  { kind: 'feedback', words: ['记住', '记一下', '别忘', '要记得'], weight: 3 },
  // 指向未来的规则
  { kind: 'feedback', words: ['以后', '下次', '每次', '一律', '永远', '从现在起', '往后'], weight: 2 },
  // 长期偏好
  { kind: 'user', words: ['我习惯', '我偏好', '我喜欢', '我要求', '我希望', '我的标准', '我一向'], weight: 2 },
  // 拍板的口径
  { kind: 'project', words: ['定为', '就按', '口径是', '标准是', '以这个为准', '以这个为基准'], weight: 2 },
]

/** 反向词：出现这些时，句子更可能是任务指令而不是长期规则。 */
const TASK_MARKERS = ['这次', '本轮', '这一个', '当前任务', '这次先', '暂时', '临时', '先这样', '只做']

/** 一句话最短/最长长度（按字符）。太短没有信息，太长不像记忆。 */
const MIN_LENGTH = 8
const MAX_LENGTH = 160

function sentences(text) {
  return String(text)
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function hitsIn(sentence) {
  const found = []
  for (const { kind, words, weight } of STRICT) {
    for (const word of words) {
      if (sentence.includes(word)) found.push({ kind, word, weight })
    }
  }
  return found
}

/**
 * 从一条用户消息里抽候选记忆。
 *
 * @param text - 用户消息原文。
 * @returns 候选数组 `{ kind, summary, hits, confidence }`；无候选返回空数组。
 */
export function extractCandidates(text) {
  const normalized = normalizeText(text)
  if (normalized.length === 0) return []

  const out = []
  const seen = new Set()
  for (const sentence of sentences(normalized)) {
    if (sentence.length < MIN_LENGTH || sentence.length > MAX_LENGTH) continue
    // 反问句通常是提问，不是陈述
    if (/[？?]$/.test(sentence)) continue
    const hits = hitsIn(sentence)
    if (hits.length === 0) continue
    if (TASK_MARKERS.some((mark) => sentence.includes(mark))) continue

    // 按出现顺序取第一个命中的类型作为归属
    const kind = hits[0].kind
    const confidence = hits.reduce((sum, hit) => sum + hit.weight, 0) >= 3 ? 2 : 1
    const summary = sentence.replace(/\s+/g, ' ').trim()
    if (seen.has(summary)) continue
    seen.add(summary)

    // 凭据/框架定界符不进候选（与写入路径同一套判定）
    if (findSecrets(summary).length > 0) continue

    out.push({ kind, summary, hits: hits.map((hit) => hit.word), confidence })
  }
  return out
}

/**
 * 从一批消息里抽候选，并做跨消息去重。
 * @param messages - 纯文本数组（按时间顺序）。
 * @returns 候选数组。
 */
export function extractFromMessages(messages) {
  const seen = new Set()
  const out = []
  for (const message of messages) {
    for (const candidate of extractCandidates(message)) {
      if (seen.has(candidate.summary)) continue
      seen.add(candidate.summary)
      out.push(candidate)
    }
  }
  return out
}
