import {bindDatedQuotation} from './capture-evidence.mjs'
/** Short request-local labels, bound by code to the original message identity. */
export function captureSourceAliases(messages = []) {
  const originals = new Set(messages.map(message => message?.id).filter(id => typeof id === 'string'))
  const ids = new Map()
  const owners = new Map()
  const mapped = messages.map((message, index) => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return message
    let alias = `source${index + 1}`
    while (originals.has(alias) || ids.has(alias)) alias = '_' + alias
    ids.set(alias, message.id)
    if (message.role === 'user') owners.set(alias,message)
    return { ...message, id: alias }
  })
  return {
    messages: mapped,
    restore(batch) {
      return { ...batch, candidates: batch.candidates.map(candidate => {
        const owner = owners.get(candidate.evidence?.[0]?.messageId)
        const evidence = candidate.evidence?.map(ref => ({...ref, messageId:ids.get(ref.messageId) ?? ref.messageId}))
        return bindDatedQuotation({...candidate,evidence}, owner)
      }) }
    },
  }
}
