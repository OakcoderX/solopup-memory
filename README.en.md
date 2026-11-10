# SoloPup Memory

**Start here:** [Quick start](docs/guides/quickstart.md) · [Synthetic trials](docs/README.md) · [FAQ](docs/faq.md) · [Feedback](docs/feedback.md)

**Remember what matters. Keep up when you change your mind.** · [中文](README.md)

Current public beta: **0.22.0-beta.3** (npm `beta` tag / GitHub Release). Source-linked, layered **text memory** for DeepSeek Harness. **Public beta, not a stable release.** See the npm beta tag and GitHub releases for the currently published version. See [RELEASE.md](RELEASE.md) for tested scope and known gaps.

## Quick install

Requires an installed DeepSeek Harness and Node >=24.9. For the desktop profile:

```sh
dsh plugin --profile desktop add solopup-memory@beta --ignore-scripts
```

Restart that profile's host, then use `memory_status` to check the loaded version and status. If upgrading from `dsh-memory`, back up and remove the old plugin first; do not enable both. See [installation details](#install-in-dsh) for exact versions, legacy-store review and removal.

## What does a source-linked result look like?

These are **actual offline script results from Linux x64 / Node v24.22.1 on 2026-11-07**. They use a fictional message and production tool handlers in a scripted host, with a stubbed approval response. Write, same-project recall and other-project recall run in three separate Node processes; neither reader inherits old messages. **This is not a real DSH conversation or a real-model semantic evaluation.**

```text
synthetic user: 记住：本项目的交付说明统一用中文。
memory_write: recorded (scope=project, meaning=decision)
fresh process / memory_search("交付说明"): 1 hit (scope=project)
current text: - [project] 本项目的交付说明统一用中文 — 索引摘要
history source: synthetic-demo-write:1; quote: 记住：本项目的交付说明统一用中文。
other project / current + history: 0 + 0 hits
```

The Chinese message asks to keep this project's delivery notes in Chinese. Current search returns its effective summary. A separate `memory_search({query: "交付说明", mode: "exact", view: "history"})` returns the original quote and message identity; historical content is not a current instruction. The six lines summarize tool results. See the [full receipt and limitations](docs/runs/2026-11-07-source-recall.md), or run `node scripts/demo-source-recall.mjs` from the checkout. [Natural fresh-chat acceptance](docs/guides/fresh-chat.md) still needs a separate DSH run.

## What it keeps

- Separate global preferences from project decisions.
- Keep original owner-message citations, conditions, exceptions and optional expiry.
- Review native writes and automatic capture before making new records effective.
- Keep corrections and historical values separate from current rules.
- Represent preferences, decisions, claims, beliefs, values, references and episodes without treating memory as proof or permission to act.
- Coordinate source withdrawal across managed stores and preserve withdrawal barriers during a reviewed restore.

## Install in DSH

Use the official plugin-manager command in [Quick install](#quick-install).

The beta tag follows verified public beta releases. For an exact version, choose a published version from the release page, for example `solopup-memory@0.22.0-beta.3`. Git installation remains available with `github:OakcoderX/solopup-memory#v0.22.0-beta.3`; the release page supplies a full commit SHA for an immutable Git pin. This package ships executable ESM and has no dependency installation or build scripts. Alternatively download its release tarball and install the local file with `dsh plugin --profile desktop add /absolute/path/to/solopup-memory-0.22.0-beta.3.tgz --offline --ignore-scripts`.

Restart the profile and use `memory_status`. Existing legacy stores may require explicit local review. Do not delete control files to bypass that review. If upgrading from `dsh-memory`, create a full private backup, stop the hosts using that data, remove the old package, then install SoloPup Memory. Do not run both packages together. The data location and legacy format identifiers are intentionally retained.

Uninstalling preserves data:

```sh
dsh plugin --profile desktop remove solopup-memory
```

For DSH's experimental **Custom plugin markets**, add this source in Discover:

```text
https://raw.githubusercontent.com/OakcoderX/solopup-memory/main/market/index.json
```

This is a self-hosted index using the official format, not an official endorsement or a default built-in listing.

## Storage and limitations

Markdown stores indexes and topic text. Local ledgers store sources, candidates, revisions and invocation history. A separate SQLite coordinator stores managed identity and source-withdrawal state. A Markdown-only copy is not a complete backup. Use `scripts/backup.mjs`; [Chinese backup instructions](README.md) describe reviewed restore and retained withdrawal controls.

Automatic capture normally attempts every four turns. Native `memory_write` also requires source review. Pending, rejected and unapplied proposals are not effective memories. Model review may miss information or misinterpret it. Check the original sources for important decisions.

Retrieval uses lexical matching, not embeddings; cross-language and synonym recall are limited. A user message must fit the current 2,000-character complete-source window. Long sources are refused rather than silently shortened into memory. Withdrawal covers tracked managed projections, not original chats, remote services, external backups or unknown copies. Memory does not authorize sending messages, buying, deleting or publishing. This is not a full probabilistic POMDP solver.

Verified locally on macOS with DSH Node 24. Other runtime/platform results must be read from actual CI and release receipts; registration or unit tests alone do not establish semantic quality or sustained-use acceptance.

## Development

Requires Node >=24.9. No npm dependencies are needed for the test suite. Tests live in `test/`; runtime modules retain their existing paths. The full explicit test set is preserved in both `npm test` and the package archive.

```sh
npm test
node scripts/verify.mjs --no-accept
node accept.mjs --profile desktop
```

`verify` additionally requires a locally installed DSH and runs isolated load and mechanical gates. `accept` reads the selected profile and the live version marker; it does not certify natural-dialogue quality. See [SECURITY.md](SECURITY.md), [COMPATIBILITY.md](COMPATIBILITY.md) and [CHANGELOG.md](CHANGELOG.md).

MIT License. Copyright © 2026 oakfilm.

Explicit requests to remember durable information are directed to the native `memory_write` tool in the same turn. A separate protocol context is available even when the memory store is empty. Personal self-reports remain claims; assistant guesses are not confirmed facts. Automatic capture uses short, code-bound source labels before the original identity and quote checks. This remains a public beta, and instructions do not guarantee model compliance.

Recognized private content is excluded from automatic memory projection and unrelated saved-memory context in capture/admission review. Current and historical search hide it by default; includePrivate=true enables explicit on-demand retrieval. These are conservative content rules, not exhaustive classification or a filesystem security boundary. Raw Markdown and provenance remain local plaintext. Explicit retrieval still enters session history and model requests. Existing session archives, exports, backups and already-sent data are not erased.
