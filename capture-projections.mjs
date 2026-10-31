/** Data-only views of already filtered current source records. Not new evidence. */
import {candidateDetail} from './withdrawal.mjs'
export function captureProjection(record,scope,prefixedIndexLine,topicText){
 const block=record.detail===undefined?undefined:candidateDetail(record.id,record.detail)
 const hasDetail=block!==undefined&&typeof topicText==='string'&&topicText.indexOf(block)>=0&&topicText.indexOf(block)===topicText.lastIndexOf(block)
 return{scope,recordId:record.id,type:record.type,indexLine:prefixedIndexLine,summary:record.summary,meaning:record.meaning??null,origin:record.origin??'reviewed-adoption',sessionId:record.sessionId,evidence:record.evidence.map(({messageId,quote})=>({messageId,quote})),detailAvailable:hasDetail,...hasDetail?{detail:record.detail}:{}}
}
