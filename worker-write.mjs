/** 并发 worker：向同一个库写 N 条。由 test-concurrency.mjs 以多进程方式拉起。 */
import { writeMemory } from './index.mjs'
import { retryBusyWrite } from './capture-jobs.mjs'

const [dir, prefix, countText] = process.argv.slice(2)
const count = Number(countText)

let attempts = 0
for (let i = 0; i < count; i += 1) await retryBusyWrite(
  () => writeMemory({ type: 'user', dir, line: `- [user] ${prefix}-${i} — user.md` }),
  { beforeAttempt: () => { attempts += 1 } },
)
console.log(JSON.stringify({ writes: count, retries: attempts - count }))
