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
- The official [DSH site](https://www.deepseek.com/en/harness/) links its community plugin entry to the GitHub `dsh-plugin` topic. The repository uses that topic. No central listing approval or npm publication is claimed.
