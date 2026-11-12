# Super Agent and project-memory examples — 2026-11-12

These examples use fictional data and SoloPup Memory **0.23.0-beta.2**, a public beta. They illustrate observed behavior in bounded tests, not a guarantee of semantic accuracy, security isolation, or unattended operation.

## 1. A real model across linked worktrees

In an isolated DSH home, a real model used `memory_write` to record the project decision “delivery notes default to Chinese.” The same repository had a second worktree explicitly linked with `scripts/superagent-worktree.mjs`. A fresh headless DSH session in that worktree was told that an old task record used English and asked for the current default. It retrieved the project memory, answered Chinese, and noted that a later applicable instruction would require further evidence.

The link command returned `applied: true`. The writer and reader were separate real model sessions. The reader was launched through the DSH CLI, not dispatched by Super Agent. The example does not establish general conflict-resolution accuracy.

## 2. A Super Agent Worker and a real model

In a separate isolated test using the published npm archive, the pinned Super Agent prototype (`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`) used its Engine, DshExecutor and Sessions to create a Worker. A synthetic project memory contained “delivery defaults to Chinese”; the synthetic assignment said an old task used English and asked for the new default. The Worker request contained the project memory and SoloPup's conflict guidance. A real DeepSeek model answered Chinese, cited the injected summary, and said it had not searched other memory or changed it.

The controller, event source and other model calls were test doubles. The real model adapter forwarded the Worker's system message and first two user-context messages, not its entire history. No real GitHub or other external source was connected. This is one adapted Worker test, not an end-to-end production deployment or a guarantee that every conflict will be resolved correctly.

## 3. Prepare-failure counterexample

In the same pinned prototype, if preparation creates a workspace and then fails, an immediate retry can skip preparation, start a Worker and omit the intended project memory. An experimental prototype patch blocked that retry and allowed recovery after the leftover workspace was inspected and preparation rerun. That patch is **not part of the official prototype or SoloPup Memory**. The supported operational precaution is to inspect the leftover workspace and ensure preparation will rerun before retrying.

The original G1 aggregate was not passed. The earlier proposed personal-memory isolation requirement was removed from this release's scope; this does not turn the original aggregate green. Revocation does not promise removal from existing conversations, model requests or external copies.

## Try the mechanics

Install the beta using the [README](../../README.en.md#quick-install), then follow the [explicit worktree link instructions](../../README.en.md#project-memory-across-worktrees-023-beta). The reproducible offline source-recall demo runs with `node scripts/demo-source-recall.mjs`; it uses a scripted host and is **not** a real-model test. The repository's `test/test-project-stores.mjs` exercises explicit same-repository linking with synthetic data. Do not run experiments against a personal memory store without a backup.
