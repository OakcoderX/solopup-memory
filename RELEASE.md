# 0.22.0-beta.3 — DSH 0.2.2 compatibility and first-run integration

**Published public beta.** Published to npm as `0.22.0-beta.3` (dist-tag `beta`) and to GitHub Releases on 2026-11-09; the npm tarball sha256 `621bf9c0d21e39d769377a421e80330402c7d9d5840745209b8500a11c9f2fe2` matches the release `SHA256SUMS`. `memory_status` should report `0.22.0-beta.3` after a clean restart. This version integrates the onboarding/test-layout work with current main and waits for DSH asynchronous Session Projection registration before exposing dependent features. New hosts use retained projection handles; older hosts retain their registry-reader path. Existing beta tags and the published registry version are not rewritten.

The isolated Linux host checks use the official npm CLI distributions for DSH 0.2.1-rc.5 and 0.2.2-rc.1, synthetic Sessions, no user profile or credentials, and no model calls. They cover six-tool activation, live projection state, exact removal of obsolete memory sections while preserving other content, cold replay, rejected registrations and owner disposal. This is not real-model semantic acceptance or daily desktop verification. See [COMPATIBILITY.md](COMPATIBILITY.md) and the integration receipt for exact results and remaining gates.

# 0.22.0-beta.2 — detection layer, semantic pipeline gate, dream P0/P1

**Superseded by 0.22.0-beta.3; never published.** (v0.22.0-beta.1 tag failed before submission because npm 11 parsed the relative tarball path as a GitHub shorthand; no npm version was published. This beta.2 commit fixes the path and passes the same gates, but publication completed only with beta.3.) This commit adds engineering infrastructure and read-only/planning features; stable semantic acceptance is still not claimed.

- L0 detection: `detect.mjs` + `scripts/detect.mjs` read-only invariant checks (index format, projection consistency, anchors, withdrawal residue, duplicates/conflicts, budgets, scope, version drift, topic structure, duplicate stores). `memory_status` exposes a bounded `lint` summary.
- L2 pipeline-fidelity suite: 10 frozen cases (~190ms) checking that a correct or deliberately wrong candidate keeps its conditions/meaning/expiry/scope through write → projection → retrieval. `semanticTruthEvaluated` stays false (no real extraction model run).
- L3 telemetry: capture success rate, zero-output days, stale pending candidates, short-session skips.
- Dream P0 shadow plan: read-only op list from L0+L3 with evidence, zero model calls. Dream P1 applies only `compact-index` (reuses deterministic `pruneStore`) behind `--reviewed <planHash>`, after a file backup, with post-apply L0 verification; every other op remains human-only.
- Short sessions below the auto-capture turn threshold now emit `capture/skipped/short-session-below-threshold` instead of silently losing context.
- Add a mechanical security self-check (`scripts/security-check.mjs`, wired into `verify`): zero runtime dependencies and install hooks; no runtime network calls or listening sockets; the single subprocess is `restore.mjs` invoking fixed-argument `tar` without a shell; no secrets or machine absolute paths in shipped files; workflow actions pinned to commit SHAs with `contents: read`, no `secrets.*` and no `pull_request_target`; package contents exclude research/logs/tarballs; MIT license, engines and `.gitignore` present.
- Add a reliability test (`scripts/soak.mjs`) on the official offline install path: repeated real DSH host start/stop, SIGKILL recovery with no leftover `.write.lock`/`.publication.json`, two concurrent hosts on one store followed by a clean reload, unchanged memory content files across cycles, and store permissions 0700 (files 0600).

Known gaps: no real-model semantic acceptance; no per-memory usage counters; dream P1 does not apply merges, conflict arbitration or transcript-based corrections.

# 0.21.0-beta.4 — automated beta release infrastructure

This maintenance version adds the repository release workflow, OIDC publishing support, immutable artifact checks and post-publish GitHub/market updates. Memory behavior and data formats are unchanged. Hosted workflow success and trusted-publisher validation must be checked in the release receipts; a workflow file alone does not establish them. Stable semantic acceptance and historical erasure remain outside this release.

## Historical beta.3 release evidence

# 0.21.0-beta.3 - private-memory exposure reduction

Public beta. Conservative known-category filtering, not full privacy isolation or stable semantic acceptance.

Recognized private summaries, details and quoted evidence are excluded from automatic memory projection and unrelated saved-memory context for capture and admission review. Default current/history searches hide this content; includePrivate=true allows on-demand retrieval. Existing records and original session logs are preserved. File tools can still read raw data, classifier coverage is incomplete, and on-demand output still enters logs and model requests. Raw-index pointer migration and physical history cleanup are not part of this release.

Prior beta.2 evidence below is historical and not automatically a beta.3 result.

---

# 0.21.0-beta.2 — explicit memory workflow update

Public beta, not stable semantic acceptance. The beta.1 evidence in the historical section below is not automatically a beta.2 result.

- Add a separate, scoped protocol context directing explicit remember requests to the real memory tool in the same turn, with truthful success/pending/failure reporting. It is available even with an empty index. Model compliance is still checked through actual calls, not assumed from instructions.
- Keep personal self-reports as claims and assistant guesses separate; do not use shell imports or fabricated provenance to bypass native validation.
- Shorten automatic-capture message labels with a request-local code binding. Original role, quote, scope and source withdrawal checks still apply.
- No data schema change; existing records and provenance are preserved. Existing semantic and platform gaps remain open.

Verified in the daily macOS DSH host using the actual DeepSeek account and Standard preset: an ordinary remember request invoked the native memory tool and was recorded in its first turn; a fresh conversation without inherited history recovered the project fact. A separate fresh conversation recovered an existing global personal fact. One real extraction preserved the original user source through the short labels and omitted an assistant-invented place. Synthetic test sources were withdrawn and original Markdown remained unchanged.

The first test attempt exhausted its own call cap before the global-personal query could answer; that attempt is retained as incomplete, with a separately identified successful follow-up. These bounded cases do not establish general semantic accuracy or stable-release readiness.

---

## Historical beta.1 release evidence

# 0.21.0-beta.1 — public beta / 公开测试版

SoloPup Memory is the public product name of the former local `dsh-memory` plugin. This release derives from the privately tested dev.45 implementation. It is **not stable** and does not claim superiority over other memory systems.

## Changes in this public package

- Use `solopup-memory` for the package, DSH bundle and GitHub repository; add English/Chinese product metadata and an icon.
- Retain the `memory` plugin row, tools, data locations, schema identifiers and snapshot kind for compatibility.
- Accept both the former and new package names when reviewing a restore target archive; keep protocol, data capability and SHA checks intact.
- Replace a machine-specific legacy acceptance script with read-only checks of the selected official profile installation and live runtime.
- Fix the legacy patch helper default path in Unicode/space-containing checkouts, with an actual subprocess regression.
- Ship no research directories, user memory, original conversations, account data or machine-specific private reports.

## Existing evidence and remaining work

The dev.45 base passed 970 source tests and 970 actual-archive tests; its official local lifecycle study used 22 hosts and 14 manager actions. In the actual daily desktop, native write → one real synthetic-source model review → search → source withdrawal passed. Those results describe the prior base; the renamed package must be tested separately and its actual counts are recorded with the GitHub release and CI.

The dev.44 development study answered all five cold-start queries correctly, but its unchanged prospective mechanical gates passed only two of five cases. Review of 14 current/checkpoint records supported 13 and left one soft/default versus draft-exception applicability concern. One automatic extraction failed with `capture-invalid-envelope`; two workflow oracles were also too strict about equivalent condition representations. These are not regraded into an acceptance pass.

Stable release still requires prospective semantic acceptance, handling/documenting automatic extraction failures, sustained daily use and supported distribution/platform checks. No multi-day reliability or independent comparative superiority claim is made. Text only; no image, audio or video memory.

## Official publication contract

- [Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md): the package declares `dsh.bundle.patch`; direct Git and archive installation are supported.
- [Plugin markets](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market): publish a format-1 HTTPS index with a Git version pinned to a full commit; users add the source themselves.
- The official [DSH site](https://www.deepseek.com/en/harness/) links its community plugin entry to the GitHub `dsh-plugin` topic. The repository uses that topic. No central listing approval is claimed. The same tested beta archive was subsequently published to npm as `solopup-memory@0.21.0-beta.1` with the `beta` tag; the market index now installs this exact npm version.
