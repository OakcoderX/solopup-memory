/** Build the companion's tiny export surface from a clean pinned upstream checkout. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SUPER_AGENT_DREAM_PROTOTYPE } from '../dream-superagent.mjs'

const source = process.argv[2]
if (!source || process.argv.length !== 3) throw Error('Usage: node scripts/dream-companion-build.mjs /path/to/pinned/dsh-superagent-prototype')
const root = realpathSync(source)
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
if (git('rev-parse', 'HEAD') !== SUPER_AGENT_DREAM_PROTOTYPE || git('status', '--porcelain', '--untracked-files=no')) {
  throw Error(`Use a clean upstream checkout at ${SUPER_AGENT_DREAM_PROTOTYPE}`)
}
const tsdown = join(root, 'node_modules', '.bin', 'tsdown')
if (!existsSync(tsdown)) throw Error('Install the pinned checkout dependencies with pnpm install --frozen-lockfile --ignore-scripts')
const stage = mkdtempSync(join(root, '.solopup-dream-entry-'))
try {
  const entry = join(stage, 'solopup-dream-prototype.ts')
  const out = join(root, '.solopup-dream-bundle')
  writeFileSync(entry, [
    "export { Store } from '../src/app/store.ts'",
    "export { Engine } from '../src/core/index.ts'",
    "export { DshExecutor } from '../src/executor/dsh.ts'",
    "export { Sessions } from '../src/app/sessions.ts'",
    '',
  ].join('\n'))
  execFileSync(tsdown, [entry, '--no-config', '--out-dir', out, '--format', 'esm', '--no-dts', '--platform', 'node'],
    { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  const prototypeBundle = join(out, 'solopup-dream-prototype.mjs')
  const prototypeBundleSha256 = createHash('sha256').update(readFileSync(prototypeBundle)).digest('hex')
  console.log(JSON.stringify({ prototypeBundle, prototypeBundleSha256, prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE }, null, 2))
} finally { rmSync(stage, { recursive: true, force: true }) }
