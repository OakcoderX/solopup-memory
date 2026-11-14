#!/usr/bin/env node
import { prepareMarkdownReference } from '../markdown-reference.mjs'

const [path, heading, version, ...extra] = process.argv.slice(2)
if (path === undefined || heading === undefined || version === undefined || extra.length) {
  console.error('在项目根目录运行：node <path-to-solopup>/scripts/reference-markdown.mjs <相对稿件路径> <章节标题> <版本>')
  process.exitCode = 2
} else {
  try {
    const result = await prepareMarkdownReference(process.cwd(), { path, heading, version })
    console.log(result.approval)
  } catch (error) {
    const status = error?.status ?? (error?.code === 'ENOENT' ? 'missing' : 'unavailable')
    console.error(`稿件引用生成失败（${status}）`)
    process.exitCode = 1
  }
}
