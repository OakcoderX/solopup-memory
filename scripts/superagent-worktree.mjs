#!/usr/bin/env node
/** Explicitly configured Super Agent prepare helper; never creates worktrees or calls a model. */
import { isAbsolute } from 'node:path'
import { linkProjectWorktree } from '../index.mjs'

try {
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== '--owner' || !isAbsolute(args[1]) || args[2] !== '--apply') throw Error('usage: superagent-worktree --owner /absolute/project --apply')
  const worktree = process.env.DSH_SUPERAGENT_DIR
  if (typeof worktree !== 'string' || !isAbsolute(worktree)) throw Error('DSH_SUPERAGENT_DIR must be an absolute worktree path')
  // Installing this command in the trusted prepare configuration is the user's
  // opt-in; the project store still validates Git identity and stale reviews.
  const preview = linkProjectWorktree(worktree, args[1])
  const result = linkProjectWorktree(worktree, args[1], { apply: true, reviewed: preview.reviewed })
  if (!result.applied && !result.alreadyLinked) throw Error('worktree association was not applied')
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
