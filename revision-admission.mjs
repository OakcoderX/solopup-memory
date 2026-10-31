/** Only deterministic proposal-preparation refusals; never swallow storage/corrupt-state errors. */
const codes=new Set([
 'capture-invalid-replacement',
 ...['mode-needs-target','invalid-mode','target-needs-complete-replacement','kind-change-needs-complete-replacement','content-meaning-needs-complete-replacement','retention-change-needs-complete-replacement','meaning-change-needs-complete-replacement','source-overflow'].map(name=>'memory-revision-'+name),
])
export const isRevisionAdmissionError=error=>typeof error?.code==='string'&&error.code===error.message&&codes.has(error.code)
