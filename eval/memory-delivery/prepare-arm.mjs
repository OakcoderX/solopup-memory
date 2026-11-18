import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const [armArg, archiveArg, expectedDigest, expectedVersion] = process.argv.slice(2)
assert.ok(armArg && (!archiveArg || /^[0-9a-f]{64}$/.test(expectedDigest) && expectedVersion),
  'Specify arm root and, for enabled arms, archive/checksum/version')
const arm = resolve(armArg)
const home = join(arm, 'home')
const tmp = join(arm, 'tmp')
const cwd = join(arm, 'checkout')
const profile = 'coding'
const dir = join(home, 'profiles', profile)
const app = '/Applications/DeepSeek Harness.app'
const cli = join(app, 'Contents/Resources/runtime/cli/bin/dsh')
assert.ok(existsSync(join(cwd, '.git')), 'Checkout Git metadata unavailable')
assert.ok(!existsSync(home), 'Use a fresh isolated DSH home')
mkdirSync(tmp, { recursive: true, mode: 0o700 })
mkdirSync(dir, { recursive: true, mode: 0o700 })
const packagePath = join(dir, 'package.json')
writeFileSync(packagePath, JSON.stringify({
  name: 'dsh-profile-coding',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  dependencies: {},
}))
writeFileSync(join(dir, 'cordis.yml'), '[]\n')
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, DSH_HOME: home,
  USERPROFILE: home, CFFIXED_USER_HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1',
}
function cliRun(args) {
  const result = spawnSync(cli, args, { cwd, env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, (result.error?.message || result.stderr || result.stdout).slice(-2000))
  return result.stdout.trim()
}
const version = cliRun(['--version'])
let plugin
if (archiveArg) {
  const archive = resolve(archiveArg)
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  assert.equal(digest, expectedDigest, 'Unexpected SoloPup package')
  const listed = spawnSync('/usr/bin/tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' })
  assert.equal(listed.status, 0, 'Unable to read verified archive manifest')
  const manifest = JSON.parse(listed.stdout)
  assert.equal(manifest.name, 'solopup-memory')
  assert.equal(manifest.version, expectedVersion)
  cliRun(['plugin', '--profile', profile, 'add', archive, '--offline', '--ignore-scripts'])
  const config = JSON.parse(readFileSync(packagePath, 'utf8'))
  assert.ok(config.dsh.profile.bundles.includes('solopup-memory'), 'SoloPup bundle missing after installation')
  plugin = { name: manifest.name, version: manifest.version, sha256: digest }
}
const receipt = { arm, home, cwd, version, plugin: plugin ?? null }
writeFileSync(join(arm, 'prepared.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(receipt))
