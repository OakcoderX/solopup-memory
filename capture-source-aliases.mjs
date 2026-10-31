/** Short request-local labels, bound by code to the original message identity. */
export function captureSourceAliases(messages = []) {
  const originals = new Set(messages.map(message => message?.id).filter(id => typeof id === 'string'))
  const ids = new Map()
  const mapped = messages.map((message, index) => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return message
    let alias = `source${index + 1}`
    while (originals.has(alias) || ids.has(alias)) alias = '_' + alias
    ids.set(alias, message.id)
    return { ...message, id: alias }
  })
  return {
    messages: mapped,
    restore(batch) {
      return { ...batch, candidates: batch.candidates.map(candidate => ({ ...candidate,
        evidence: candidate.evidence?.map(ref => ({ ...ref, messageId: ids.get(ref.messageId) ?? ref.messageId })),
      })) }
    },
  }
}
