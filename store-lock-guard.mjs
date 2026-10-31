/** No storage imports: lets the shared local lock acquire global ownership first. */
let guard
export function installStoreLockGuard(value){if(guard&&guard!==value)throw Error('managed-memory-duplicate-lock-guard');guard=value}
export function guardStoreLock(dir,run){return guard?guard(dir,run):run()}
