/** Keep one copy of each exact index row in a section, preserving its source records. */
export function deduplicateDreamIndex(source) {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0] ?? ''
  const rows = source.slice(frontmatter.length).match(/[^\n]*\n|[^\n]+$/g) ?? []
  const seen = new Set()
  const kept = [frontmatter]
  let fence
  let removed = 0
  for (const row of rows) {
    const line = row.replace(/\r?\n$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length &&
          /^ {0,3}(?:`+|~+)[ \t]*$/.test(line)) fence = undefined
      seen.clear()
    } else if (!fence && /^ {0,3}#{1,6}(?:\s|$)/.test(line)) seen.clear()
    else if (!fence && /^- \[(?:user|feedback|project|reference)\] \S/.test(line)) {
      if (seen.has(line)) {
        removed++
        continue
      }
      seen.add(line)
    }
    kept.push(row)
  }
  return { text: removed ? kept.join('') : source, removed }
}
