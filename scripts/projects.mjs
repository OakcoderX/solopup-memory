#!/usr/bin/env node
/** Local migration review only. No model-callable adoption or automatic old-store copying. */
import { resolve } from 'node:path'
import { reviewProjectStore, migrateLegacyProjectStore, recoverLegacyProjectStore, linkProjectWorktree, unlinkProjectWorktree } from '../index.mjs'
const args = process.argv.slice(2), command = args.shift() ?? 'inspect'
function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(name + ' requires a value')
  const value = args[index + 1]; args.splice(index, 2); return value
}
try {
  const cwd = resolve(option('--cwd') ?? process.cwd()), reviewedTree = option('--reviewed-tree'), reviewedClaim = option('--reviewed-claim'), reviewedMigration = option('--reviewed-migration'), owner = option('--owner'), reviewedLink = option('--reviewed-link')
  const i = args.indexOf('--apply'), apply = i >= 0
  if (apply) args.splice(i, 1)
  if (args.length || !['inspect', 'migrate', 'recover', 'link', 'unlink'].includes(command) || command === 'inspect' && apply) throw Error('usage: projects inspect/migrate/recover/link/unlink --cwd path; link needs --owner; apply needs matching review hash')
  if (command === 'link' && !owner) throw Error('link requires --owner')
  const result = command === 'inspect' ? reviewProjectStore(cwd) : command === 'migrate' ? migrateLegacyProjectStore(cwd, { apply, reviewedTree, reviewedClaim }) : command === 'link' ? linkProjectWorktree(cwd, owner, { apply, reviewed: reviewedLink }) : command === 'unlink' ? unlinkProjectWorktree(cwd, { apply, reviewed: reviewedLink }) : recoverLegacyProjectStore(cwd, { apply, reviewedMigration })
  console.log(JSON.stringify(result, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
