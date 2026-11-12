# Changelog

## 0.24.0-beta.2 — idle project memory review

- Opt-in Dream Review waits for DSH to be idle, checks one selected project at a time, and creates a source-linked report for user review.
- A later explicit correction can reopen the exact DSH message. Opening the report checks the references again and hides recommendations whose evidence can no longer be verified.
- Ordinary DSH and the experimental macOS Super Agent companion share a durable queue, budget and reports. Explicit switches wait for the active run to finish.
- Formal memories continue to change through the existing write and confirmation flow. See [Dream Review setup](docs/dream-review.md).
- Includes the next-session experiment and its tests in the source and package gates. The earlier beta.1 tag stopped at the test manifest check before npm publication.

## 0.23.0-beta.2 — conflict-aware memory guidance

- Guide agents to compare sources, scope and time when task history and long-term memory disagree, follow explicit current user corrections, and ask when evidence is insufficient.
- Report whether `memory_search` is available to the current session; when it is unavailable or cannot be verified, do not claim a search was performed or that missing memory does not exist.
- Preserve task history and existing memory admission rules; this guidance does not erase historical copies or guarantee model behavior. Super Agent workers still require explicit worktree setup and do not have memory tools by default.
- The tested Super Agent prototype can skip preparation on retry after a failed preparation, causing a worker to start without project memory. Inspect the leftover workspace and ensure preparation reruns before retrying; this release does not fix the prototype.
- Candidate validation and release status must be verified against release artifacts; no claim of real Super Agent semantic acceptance is implied.

## 0.23.0-beta.1 — project memory across worktrees

- Add an explicit, review-before-apply link between worktrees of the same local Git repository so a worker can use an existing project memory store. Existing independent stores are not merged or overwritten; linking is disabled until explicitly configured.
- Add a reviewed unlink operation, local repository replacement detection, and concurrent registration protection.
- The tested Super Agent prototype does not expose memory search or write tools to workers by default. A failed prepare can be skipped on retry; inspect the leftover directory and ensure preparation reruns before retrying.
- Unlinking affects future path resolution, not in-flight work or existing conversation copies. Full G1, real-model semantics, cross-platform behavior, and all concurrency cases are not certified.


## 0.22.0-beta.3 — DSH 0.2.2 compatibility and first-run integration

- Await callable asynchronous Session Projection registrations before publishing tools, prompt contributions or the successful load marker. Retain the new handle and use its `stateOf(session)`; preserve the legacy registry reader for older hosts. Registration rejection fails activation.
- Integrate PR #2 first-run instructions, source-recall example and test-directory organization with the current detection, telemetry, dream planner and lock-contention fixes. All tests, including the newer main-branch suites, remain in the package and npm test.
- Add real CLI/Loader history-contract probes covering activation, live Session projection, scoped history replacement, cold replay, registration rejection and disposal, using isolated homes and synthetic input without model calls. The actual archive runs these checks too.
- Published as public beta `0.22.0-beta.3` to npm (dist-tag `beta`) and GitHub Releases; the npm tarball sha256 matches the release checksum. This is still not a claim of desktop semantic acceptance or production-data testing, and existing beta tags are unchanged.

## 0.22.0-beta.2 — detection layer, semantic pipeline gate, dream P0/P1

- Add `detect.mjs` and `scripts/detect.mjs`: read-only L0 invariant checks over a store or the whole memory root (index format, projection consistency, anchors, withdrawal residue, duplicates/conflicts, budgets, scope, version drift, topic structure, duplicate stores). No model calls, no writes.
- Expose a bounded `lint: { errors, warnings, checks[] }` summary in `memory_status` (single and scope=both); full details stay in the CLI.
- Record `capture/skipped/short-session-below-threshold` when a session ends below the auto-capture turn threshold, so short sessions are observable instead of silently losing context.
- Fix two stale comments that described the similarity gate as 0.95/0.85 while the constants are 0.90/0.80.
- Add `scripts/telemetry.mjs`: L3 read-only metrics (capture success rate, zero-output days, stale pending candidates, short-session skips) with `--json`/`--check`.
- Add `eval/semantic-suite.mjs` + `eval/semantic/cases.json`: 10 frozen L2 pipeline-fidelity cases (identity claim, conditional preference, project decision, inferred pending, verbatim-quote gate, scope gate, missing basis, supersede, condition-in-detail, expiry). Deterministic (~250ms); `semanticTruthEvaluated` stays false because it does not run a real extraction model.
- Add `eval/bench-detect.mjs`: comparison experiment against the 2026-11-08 manual audit baseline (detector recall, declared blind spots) plus median latency of L0/L3 gates.
- Tighten I14: mid-file paragraphs ending with unfinished punctuation are flagged; colon lead-ins followed by a list are not.
- Add `scripts/dream.mjs`: read-only P0 shadow planner (detection + telemetry → auditable ops, `applySupported:false`, zero model calls).
- Add `scripts/security-check.mjs`: mechanical pre-release checks (zero dependencies/install hooks, runtime network/exec surface, shipped-file secrets and absolute paths, workflow action pins and permissions, package contents, license, engines, gitignore). Integrated into `scripts/verify.mjs`.
- Fix the npm publish invocation: pass `./release/<tarball>` so npm 11 does not parse the relative path as a GitHub shorthand (previous `v0.22.0-beta.1` tag failed before any submission; no npm version was published).
- Add `scripts/soak.mjs`: reliability test on the official offline install path — repeated real DSH host start/stop, SIGKILL recovery, two concurrent hosts on one store, data fingerprint stability and store permissions (0700/0600).
- Add DETECTION.md (six-layer framework and its known blind spots) and DREAMING-DESIGN.md (next feature design; P0 implemented, P1+ not).

## 0.21.0-beta.4 - automated release infrastructure

- Add a repository-scoped GitHub Actions workflow for npm trusted publishing via OIDC, with beta tag/version checks and a fixed source commit.
- Test source on Linux/macOS and the actual archive; retain platform gate receipts, report shared-runner absolute timing misses, and require a fixed-beta.3 same-runner performance comparison. The original local Mac timing gate is unchanged.
- Verify the public npm download before creating the GitHub prerelease and updating the configured market index. No stored npm write token is required.
- No change to memory admission, retrieval, privacy classification, storage format or historical-erasure behavior. Actual hosted workflow/trust validation is recorded in release receipts, not assumed from this configuration.

## 0.21.0-beta.3 - private-memory exposure reduction

- Exclude recognized personal profiles, birth details, health, intimate and private contact information from automatic index projection and unrelated capture/review context, including private source quotations.
- Hide these records from default current/history memory searches; explicit includePrivate=true enables on-demand retrieval and its normal log/model exposure.
- Preserve stored records, source identities and append-only session logs. Forget results now distinguish index withdrawal from historical erasure.
- This is a conservative content classifier, not exhaustive PII detection, encryption, a file-access boundary, or remote deletion. Raw Markdown, source ledgers and existing archives still require separate handling.

## 0.21.0-beta.2 — explicit memory workflow

- Move model-facing memory instructions into a separate protocol context, available with an empty index and reporting scoped write-tool availability.
- Direct explicit durable-memory requests to the real tool in the same turn; distinguish recorded/duplicate, pending and rejected results. Personal statements remain claims; guesses are not promoted.
- Bind short automatic-capture source labels back to original message identities before the unchanged role and quotation checks.
- Preserve source validation, managed withdrawal, storage schemas and historical beta.1 evidence. This remains a public beta.

## 0.21.0-beta.1 — SoloPup Memory public beta

- Publish the dev.45-derived plugin as SoloPup Memory (`solopup-memory`), with localized DSH metadata, executable ESM and a Git-compatible bundle.
- Preserve data/schema identities, source withdrawal controls and old snapshot compatibility; add the new package name to reviewed restore targets.
- Fix the legacy patch helper default path and fixtures in directories containing Unicode, spaces or URL metacharacters.
- Replace the old workstation-specific acceptance script with read-only official-profile/runtime checks.
- Document known natural-dialogue gaps explicitly; this is not a stable release or a comparative quality claim.

## 0.21.0-dev.45 (desktop debugging candidate, not stable)

- Identify a withdrawal source by a verified session/message hash preimage. Unrelated legacy audit rows no longer block a new source across managed stores. Same-session missing lineage and unknown source identities still stop the operation.
- Discover exact preimages from validated registered source records or traceable audit entries for hash-only cleanup and interrupted-operation recovery. No new plaintext identity is persisted in the external coordinator.
- Add regression coverage for legacy data preservation, forged identities, conservative refusals, audit-only sources and both cleanup interruption boundaries. No storage schema change.

## 0.21.0-dev.44 (engineering candidate, not stable)

- Refuse incomplete owner messages before automatic capture claims or model dispatch; never treat a cropped prefix as a complete source. Block durable reconstruction even when its old prefix hash matches.
- Preserve incomplete-source information through native history selection instead of silently omitting an earlier possible exception.
- Expose the bounded pre-dispatch refusal in memory status without inventing a model job. Keep source identities and historical reads compatible; old captured interpretations are not silently repaired.

## 0.21.0-dev.43 (engineering candidate, not stable)

- Use short, code-bound references for required original owner quotes. Keep full citation coverage, checked extra sources and source limits; normalize only deeply identical duplicate bound quotes. Legacy quoted responses retain their original checks.
- Ask a separate task-restriction question before applicability review. For preferences, a reported task restriction without a stored task condition cannot be approved by seven generic supported votes; uncertainty remains unapproved. This is bounded model judgment, not proof of complete language understanding.
- Preserve historical data normalization and all new-write satisfiability/publication guards.
- Simplify installation, storage, backup and limits documentation; separate engineering results from real semantic acceptance.

## 0.21.0-dev.39 (release engineering candidate, not stable)

- Reject self-excluding new meaning before native/model admission and on all publication paths; keep legacy normalization, identities and reads compatible. A model approval cannot override the structural check.
- Show bounded, code-owned proposed append/replacement effects to reviewers. Equal metadata is not content equivalence and does not reject independent information.
- Separate acquisition instructions from review votes. Distinguish compatible additions, explicit exclusions and soft preferences; review the whole displayed owner window for later corrections.
- Classify typed preparation refusals as admission rejection without disguising corrupt stored state or I/O as a normal refusal. Preserve root limits, failed trials and prior unknown requests.
- Carry forward live transaction identity checks and per-connection SQL compilation reuse with fresh state reads.

## 0.21.0-dev.33 (in progress)

- Compile value revisions before native and automatic semantic validation. Keep scope, kind, conditions, exceptions and expiry tied to their original sources; keep the new value tied to its actual current owner, across sessions. Do not retain obsolete intermediate value roots.
- Recheck the exact parent under the publication lock. Reject changed metadata, unavailable targets, root overflow and stale publication; complete replacements require an explicit full-restatement path without inherited rights.
- Introduce source-ledger schema4 and history schema2 only when field inheritance occurs. Check target archive data capabilities before restoring a snapshot. Retain revocation protection, historical filtering and interrupted-publication recovery.
- Keep initial extraction errors, real semantic quality, actual-host behavior and comparative release acceptance separate from these local regression checks.

## 0.21.0-dev.31 (development preview)

- Bind native validation to the public Cordis service-owning injection scope. Guard generation and disposal instead of comparing per-access context-bound proxies, which incorrectly blocked dev30 before any native validator stream in the actual host.
- Preserve cancellation on provider replacement and removal. Add a regression that reproduces the frozen dev30 failure with fresh proxies and proves the lifecycle-bound behavior independently of semantic-quality fixtures.

## 0.21.0-dev.30 (development preview)

- Add a separate no-rewrite semantic gate before native memory_write publication, including checked execution observations. Return explicit recorded, duplicate, pending-review, rejected or not-applied outcomes; never render an unpublished proposal as recorded.
- Bind validation to the actual native call with a durable at-most-once claim. Use admitted same-project owner history only, preserve all accepted citations, and block publication after cancellation, disposal, route/scope/revision changes or source withdrawal.
- Reject incomplete long owner inputs instead of silently losing trailing conditions. Keep short native owner evidence distinct from the unchanged pending-inbox and automatic-extraction quote requirements. Do not guess a provider when the native route is absent.
- Keep acquisition and validation separate, following the existing pinned Codex extraction/consolidation and OpenClaw code-owned provenance choices. Semantic correctness and comparative superiority still require real, independent evaluation.

## 0.21.0-dev.29 (in progress)

- Retain every current owner source cited by an accepted validation in the published provenance; preserve the three-source bound and full withdrawal lineage. Keep dev28 evidence unchanged.
- Reject definitively unsupported candidates without persisting them in the inference inbox; only uncertain new proposals remain pending, and unapproved replacements stay unapplied.
- Audit the parent/child invocation link before model dispatch. Export bounded failure-stage/category metadata, retry only typed local contention, and prevent late dispatch after asynchronous guard cancellation.

## 0.21.0-dev.28 (in progress)

- Separate automatic candidate acquisition from a read-only accept/reject/uncertain validation task. Only approve unchanged, fully source-cited candidate identities; never execute model revisions from the validator.
- Persist a separate bounded validation invocation; preserve source/version/withdrawal guards and at-most-once behavior across observed errors, late output and process death. Keep compatible invocation/diagnostic schemas; validation child proposes zero memory entries.
- Keep unapproved new candidates non-injected; do not downgrade an unapproved replacement into a targetless append. Native-write semantic validation remains incomplete.
- Carry the reproduced duplicate/replacement and differing-detail guards from the dev.27 source experiment. Do not import its combined review/rewrite flow.
- Prefer a substantive parent capture status when a zero-entry validation child has the same completion millisecond.

## 0.21.0-dev.26 (in progress)

- Normalize only deeply identical, exact-JSON text copies of one valid native submission; preserve strict rejection and aggregate response bounds.
- Expose bounded current structured records to source-grounded consolidation with explicit omissions and no new source authority; guard corrected publication with existing scope, quote, full-line and revision checks.
- Bind durable input configuration to the extractor contract, and prevent route/configuration/project changes from creating another invocation for the same owner-source window. Old unissued incompatible inputs fail closed; unresolved bound input stays bound.
- Clarify missing applicability terms and agent-proposed explanations across native and capture paths. Guidance is not semantic proof.

## 0.21.0-dev.25 (in progress)

- Offer one data-only candidate submission tool through the public GenerateOptions.tools contract; validate canonical stream identity, completion, bounds and exact argument envelope. Keep strict text fallback and existing diagnostics. No unsupported format controls or automatic retry.
- Bind capture job identity to the system/tool contract fingerprint.
- Share durability and applicability guidance across native writes and background extraction; distinguish task-only restrictions, fact subjects and conditional preferences. This is guidance, not semantic verification.

## 0.21.0-dev.24 (in progress)

- Require explicit epistemic meaning on new native memory writes and automatic extraction; keep legacy rows unclassified rather than inventing a type. Clarify personal/work facts as reported claims.
- Preserve conflicting duplicate interpretations as pending source-linked proposals, retaining the effective conditions and text. Report pending review without a false successful write or opaque write failure.
- Clarify relation source kinds and same-store target scopes. Retain admission guards and existing diagnostic schema for compatible readers.

## 0.21.0-dev.23 (in progress)

- Add readonly memory_status scope=both with separate global/current-project snapshots, explicit unavailable state, and one global capture diagnostic. Preserve flat single-store outputs and write scopes.
- Clarify capture topic/scope/epistemic consistency and undecided hypotheses; retain independent admission guards.
- First public-release acceptance covers text memory; multimodal memory is deferred by user request.

## 0.21.0-dev.22 (in progress)

- Add offline memory-domain backup verification and reviewed same-root restoration: external guard, quarantined prior data, latest control retention, invocation-state merge, source cleanup, receipts and resumable stages. Target archive verification binds SHA and a declared protocol; it does not install code or support arbitrary downgrade.
- Refuse active hosts/writers, pending publications, linked files, overlapping paths, changed sources and resource-limit violations.

## 0.21.0-dev.21（开发预览）

- 修复非法候选被解析器过滤成空数组后，生产捕获仍看似成功的诊断盲区；非空原响应的过滤、有效候选截断、准入拒绝和发布失败分别计数，合法候选照常处理。
- 区分模型报告无候选与空正文/错误JSON/对象包裹数组；支持一个明确JSON围栏，拒绝从任意对象或说明中挖出[]。限制响应64 KiB和64个原候选，元数据不保存响应或用户正文。
- 有界诊断随终态作业保存，memory_status读取全局保留作业并标记旧版无细分信息、未决或损坏；不据此声称语义完整，也不重发未知调用。

## 0.21.0-dev.20（开发预览）

- dev.19真实试点无法可靠获取传输层原生callId，反复猜测均被正确拒绝，最终达到执行上限而未完成冷查。新增只读memory_status(includeObservations=true)以公开可复制的真实引用，不降低写入校验或猜测映射。
- 发现列表只展示本会话、模型已见且当前仍匹配的外部工具结果，最多8条并受字节预算限制；不可用或已改写结果不返回为有效引用。
- 规范JSON参数指纹的键顺序/空白，避免重复读取因表面表示变化增加证据组。证据组仍不等于现实独立实验或概率。

## 0.21.0-dev.19（开发预览）

- 原生工具结果引用绑定实际call/result事件、来源顺序、精确引用、模型请求可见内容及当前会话内容；与用户陈述区分，但不把工具成功视作世界事实已验证。
- 观察证书与来源、索引和历史共同发布，保留所有原请求根及两个执行事件根；撤回任一来源及恢复旧文件均受控制屏障约束，容量凭据保留5根。
- 错误结果只能保存诊断经历，未决或不可证明的结果不能成为成功证据；同参数/输出的重复读取不增加证据组。当前评估区分实际输出与用户陈述，行动仍为建议。
- 冷读取保留当时已核对输出的证书，不承诺当前原物真实性或连续重验；普通自动捕获继续仅用用户引文，不能自行伪造原生证书。

## 0.21.0-dev.18（开发预览）

- dev.17真实试点合并信念时给出4条引用，超出既定3条上限，导致整条拒绝；后续观察还误用消息id作关系目标。明确公开这两项抽取契约，不降低来源验证，也不截断证据强行接受。
- 候选全部被准入拒绝时，捕获状态、审计和终态作业明确记录rejected及capture-all-rejected，区别于空数组的成功no-op。已有混合合法/拒绝候选仍分别处理，不误报文件发布故障。
- 保留dev.16/17原始失败及版本证据；针对原场景复测不作为未见质量验收。

## 0.21.0-dev.17（开发预览）

- dev.16真实观察冲突试点把观测结果误标为reference，未建立支持/反对关系。明确存放主题type与认识类别meaning.kind不同；实际报告过的比较/测量结果仍是episode，未核实不能成为降为查证入口的理由。
- 同一信念的竞争解释与反证条件合并到该条，避免拆成假独立主张；抽取仍须引用实际目标，不用规则猜测语义或补造来源。
- 认识状态及行动建议的渲染明确给出revision.state/advice.action；memory_links说明其文本相似度导航不等于证据关系，完整来源身份通过memory_search核查。
- 保留dev.16的原始失败和正确保护，不改其评分；当前仍不提供独立核验或完整信念行动闭环。

## 0.21.0-dev.16（开发预览）

- 新观察可用完整来源记录身份关联同库现行主张；只接受claim/episode的支持或反向陈述，拒绝对价值的事实证明、跨库/失效目标和递归派生关系。
- 当前检索与动态注入重新计算陈述支持、挑战和冲突；来源撤回、旧档恢复、过期与取代均重新求值。同根及传递共根记录合并计数，主张原来源的复述不能增加支持。
- 自动捕获接收带作用域的有界目标清单，目标身份不改写原索引行；关系和观察随原来源、当前投影及历史同事务发布。
- 不将陈述关系冒充独立查证或概率；反向报告引导核验，历史不套用当前结论，完整可信观测与行动反馈闭环仍待完成。

## 0.21.0-dev.15（开发预览）

- 来源关联的本地历史档案与索引、细节和来源账本同事务发布；取代、移出现行索引、过期和压缩记录关闭区间，默认检索仍只查当前视图。
- memory_search增加history视图、库内atSequence与记录时间asOf，返回来源、时间、状态及覆盖范围。旧数据仅从实际观察起算，外部修改区间明确不确定；档案不自动注入为当前规则。
- 来源撤回同时清理档案，旧档案恢复仍由独立来源根阻断；单库1024条/2 MiB，回收已关闭记录并保留缺口水位。非法链接、校验损坏和未完成发布拒绝读取。
- 当前检索隐藏已过期索引及能关联来源的过期细节；历史视图仍能显式查看过期记录，不将其当作当前有效规则。

## 0.21.0-dev.14（开发预览）

- dev.13真实例外试点的第三个候选把“尚未决定”误标为全局项目决定；原写入保护正确拒绝，但批次成为partial。现将同一范围约束提前到捕获准入与候选存储，明确审计为rejected，合法候选继续发布，不把无效候选当作文件写入故障。
- 保留类型约束和写入侧校验；没有把错误的全局决定改成可采纳。新增混合捕获回归，验证一条合法偏好与两条不合规则的候选被分别发布/拒绝。

## 0.21.0-dev.13（开发预览）

- dev.12真实试点发现命题主体/核验状态被误抽成适用条件，引发不必要的用户反问；明确这些属于主张/认识状态，只有原话中的适用情境才进conditions/except。影响决策的事实类缺失条件优先建议查证证据与情境，不把用户当外部事实的默认真值来源。
- 用户明确持有的长期可推翻信念可作为有归属的explicit陈述保存，认识状态仍为tentative；区分“用户说持有此假设”和“模型从行为推测该人的偏好”。未明说的推断继续仅进候选；只在有持续价值时保留尚未核实的主张。

## 0.21.0-dev.12（开发预览）

- meaning认识层与来源身份同事务存储，纳入记录身份核对；已采纳候选保留结构，撤回与取代沿用现有来源控制，不建立脱节的第二份语义库。
- 明确项目归属、适用条件及例外的不同含义；检索同步过滤索引与规范标记细节，未知条件不默认满足，ranked与exact均返回认识层说明。动态索引带认识层/条件标注并有预算省略提示。
- 事实主张保持reported，信念保持tentative，价值不成为事实或操作授权。依据下一决策是否受影响返回采用、核验、询问情境、实验提议或继续工作的建议，不自动执行。拒绝模型提供verified、confidence及授权字段。

## 0.21.0-dev.11（开发预览）

- dev.10真实分批纠正试点能回答新值，但旧值仍作为独立有效条目注入。自动捕获现接受supersedes，并且必须精确绑定同范围抽取快照中的唯一完整旧行，禁止片段猜测及跨范围取代。
- 沿用既有版本闸和来源发布事务；推断仍只进候选，旧后台不能覆盖新版本。当前仍由模型判断纠正语义，不是完整条件执行器、事实核验或信念推理系统。

## 0.21.0-dev.10（开发预览）

- 真实合成试点发现：跨项目的个人条件偏好被误存为当前项目规则，原项目冷召回正确但切换项目后丢失。修正抽取中的类型及归属说明，将项目边界与听众/场景条件分别处理。
- 摘要须保留条件、限制与例外；明确跨项目的个人约定可为global，仅本项目的决定继续限制为project。该变更是模型抽取规则，尚不等于结构化条件解释或完整信念更新。

## 0.21.0-dev.9（开发预览）

- 封存dev.8诊断复现：查询服务缺失的回退捕获会发送已撤回原话，虽然未发布记忆。现把准入检查放在所有捕获路径的模型准备之前，并继续在发送前及返回后检查。
- 来源判定复用规范化根身份，覆盖不可见字符别名；已撤回批拒绝，独立新会话仍可捕获，不停用整个回退能力。
- 来源账本在模型返回期间损坏时，整批明确报错并保留现场；不在未知来源状态下继续逐候选发布。

## 0.21.0-dev.8（开发预览）

- 默认加载在工具和捕获前检查来源控制；新空库自动启用，旧库提示审阅升级并暂停读取、写入及捕获，缺失/错配控制不静默重建。
- 首次使用空的规范项目目录时自动登记并继承既有来源屏障；已有内容或未知目录需审阅，不能靠切换项目绕过撤回。
- 状态工具区分受管、需升级和不可用，不用零条结果冒充空库；旧中断发布优先提示恢复。
- 捕获的去重索引在统一控制权内读取并过滤撤回内容；项目路径查询只读取控制元数据，不因无关全局正文中断而阻断已登记项目。
- 旧集成夹具改为显式完成真实审阅登记或提供合成来源，不关闭产品护栏；新增默认启用与拒绝场景。完整安装、升级回退、自然质量、信念与主动策略仍按独立证据验收。

## 0.21.0-dev.7（开发预览）

- dev.6原生流程暴露恢复旧目录后无关写入清掉投影、却留下旧采纳状态的问题。已撤回来源不再参与新证据确认，普通写入先完成本库已授权的旧采纳撤回，再发布新内容。
- 新增完整旧采纳导入、清理、整库恢复、无关新写入、普通检索及续跑的联合回归。dev.6失败记录原样保留。

## 0.21.0-dev.6（开发预览）

- 真实v0.20归档暴露旧采纳记录没有lineHash导致导入后拒读；仅用本次已审阅的候选ID、精确索引行指纹及记忆编号联合绑定，不改旧原库账本。
- 旧采纳身份分歧在登记前拒绝；未知恢复分支仍维持拒读，不由短编号猜测内容身份。
- dev.5归档及其原生/强退失败报告保留，不把机械回归通过改写成完整升级通过。

## 0.21.0-dev.5（开发预览）

- 旧本地来源撤回可显式审阅导入；同一次登记原子提交全部来源屏障并覆盖所有登记库，保留本地合并指纹及原库内容。
- 新增本地control清单、预览/初始化、状态和续跑入口；项目目录须完整声明范围，活宿主、遗漏、链接、未完成迁移和过期预览均拒绝。
- 登记提交后绑定中断可经新预览修复，不重置已提交屏障；无效初始审阅不创建控制库。
- 候选CLI支持受管采纳的控制版本及撤回审阅。默认加载自动激活、控制搬迁、完整升级回退、自然质量与平台发布门槛仍待完成。

## 0.21.0-dev.4（开发预览）

- 修复撤回等待期间无关有效写入使清理续跑停在旧版本审阅的问题；续跑在全局控制权内重新核对同一来源，继续保留无关记忆。
- 普通读取按全局撤回根核对当前来源记录，遮蔽恢复目录中此前未见的同根历史分支，续跑可重新清理。
- 两个回归场景加入产品测试；默认安装、旧策略导入、自然质量和完整分层系统仍未完成。

## 0.21.0-dev.3（开发预览）

- 显式初始化的库接入独立SQLite控制、目录外绑定及统一读写所有权；普通检索、关系、状态、候选和捕获版本读取共同检查撤回状态。
- 局部锁之前取得跨库控制权，后台旧来源及陈旧捕获版本不得发布。来源撤回先发布全部已登记库的屏障，再进行可恢复清理；后续整库或Markdown恢复可再次清理。
- 新来源的人工采纳须核对控制版本，当前确认与旧根撤回分开；未知或被改动的撤回块在受管读取时明确拒绝。
- 旧项目迁移在同一控制权内完成复制、目的库登记及已有屏障继承，保留原文件并更新复制凭据。
- 默认安装激活、旧撤回策略导入、控制账本跨位置搬迁以及自然质量和平台发布验收仍待完成。此版不是公开稳定第一版。

## 0.21.0-dev.2（开发预览）

- 分开限制待审推断与有效来源，解除持续写入因共享200条候选上限而提前停止的问题。
- 已退出当前索引的来源可自动压缩为不含正文的撤回凭据；来源根、旧内容指纹及带标记细节的位置指纹仍保留，索引/细节/凭据共同发布并可恢复。
- 来源撤回覆盖压缩后的历史记录及恢复出来的旧投影；凭据不能充当新的独立确认，显式新来源采纳与旧细节遮蔽分开处理。
- schema3的完整来源512条、历史凭据4096条、来源总量2 MiB，待审推断200条。维持既有文件安全读取上限，满时拒绝新发布并保留现行数据；memory_status新增容量与明确的账本故障状态。
- 未知主题归档、无法证明原索引身份的旧采纳记录保留全文；全局控制接线、更多遗忘边界、长期使用和公开验收仍按独立证据核对。

## 0.21.0-dev.1（开发预览）

- 自动捕获的有效引文提取与显式工具共用来源发布协议，绑定已领取作业及通过核对的原消息；索引、细节和来源账本同事务发布。
- 保留 quoted-extraction 与 tool-context 两种来源身份，均不冒充独立人工确认；两种来源间的取代、来源撤回和旧投影遮蔽共用规则。
- 保持推断候选、未知调用不重发、旧schema2拒绝覆盖降级。全局协调器接线、200条来源容量回收、主题归档及公开安装平台门槛仍未完成。

## 0.21.0-dev.0（开发预览）

- 显式工具写入绑定原生准入消息与调用，来源不明或会话不适格时拒绝写入。
- 工具背景来源使用schema2记录，和索引/带标记细节同事务发布；保留到期和取代的精确身份，来源撤回可清理旧细节。
- 工具背景不等于独立用户证词，不能通过候选采纳接口自动升级；来源有效的历史版本仅在明确版本关系字段中返回。
- 普通候选清理保留工具来源；不支持的主题归档明确阻断撤回，避免错误宣称清理完成。
- 尚未完成跨项目控制接线、全部遗忘出口、安装平台矩阵或竞品优势验证，不构成公开第一版。


## 0.20.0 — 开发候选，2026-10-29

- 修复实际v0.19默认捕获虽成功但未建立来源引用队列的问题：sessionQuery启动时尚未活动，旧实现只查询一次。改为原生依赖子作用域跟随就绪/卸载，并在兼容上下文使用点重新查询；加载标记更新实际可用性。
- 服务晚就绪时仅恢复已观察原会话的未领取输入，保留来源/项目/配置核对；最多256个弱引用、恢复并行2个会话、每原会话每批2条，不扫描其他历史。服务撤回、替换和插件卸载会撤销旧代发送/发布资格，迟到清理不会影响新代，已领取输入不自动重发。
- 新增服务代次与完整捕获/恢复生命周期回归，保留默认允许空产出及源码/安装包验证。文档纠正旧的无效模型路由“静默降级”描述，实际自v0.18起加载期拒绝。
- 实际宿主、真实默认捕获及SIGKILL恢复另行记录；第一版及独立竞品优势仍未完成。

## 0.19.0 — 开发候选，2026-10-29

- 修复项目路径slug可能碰撞共用库：新库使用完整项目根路径的SHA256标识，旧库未经审查不自动注入或分配给首位访问者，保留全局记忆与明确迁移提示。
- 新增只读项目检查、双版本审查后的旧库复制与显式中断恢复；保留原内容及候选/关系/撤回策略，拒绝覆盖目标或重复认领。活宿主与活迁移锁阻断应用；复制使用受限无链接普通文件、字节验证与有界树扫描。复制/认领/目录发布各阶段及真实SIGKILL恢复另有回归。
- 撤回日志新增明确硬链接拒绝，修正旧测试使用非法JSON而未真正验证硬链接分支的问题；改为有效JSON并断言具体拒绝原因。不把此改动当作全部通用读路径的硬链接/竞态问题已解决。
- 旧源保留副本、跨项目撤回、完整平台升级和竞品优势仍未完成；不迁移用户真实库。本版独立于冻结v0.15失败试点。

## 0.18.0 — 开发候选，2026-10-29

- 对照DeepSeek官方插件指南补充`dsh.bundle.patch`及包内配置层，使标准bundle加载能激活插件；本地patch入口作为兼容开发方式保留，修正说明中的相对路径与SDK导入禁令表述。
- 导出同步Standard Schema V1配置验证，宿主加载及直接apply在注册前拒绝无效配置；默认值与可调范围明确，未知字段和不完整路由不再静默降级。可选服务优先使用公开的活动服务查询`ctx.get`。
- 修复插件卸载后捕获仍可能写入：取消等待、传播AbortSignal，并在请求前及每次发布前检查生命周期；忽略取消的供应商迟到结果不被接受。远端停止和未知调用结果仍不保证，不自动重发。
- 官方主干指南与本机宿主分别核对，不把主干文档当安装版本能力；完整验证与标准bundle实际宿主结果另存。独立核心试点仍固定v0.15.0。

## 0.17.0 — 开发候选，2026-10-29

- 修复来源撤回只清理第一份轮转日志的缺口；扫描每类1至16号受管数字日志，单文件2 MiB、合计16 MiB上限，未知后缀、压缩归档、链接、坏行或超限时在修改前拒绝，避免漏删后报告成功。
- 发布恢复的闭合目标族扩展至受管数字日志，最多40文件；原有小规模日志继续兼容，路径和阶段文件限制保留。覆盖四类细节、32份归档、部分发布与真实SIGKILL恢复；不声称断电事务、跨项目或全部备份擦除。
- 保留实际v0.16包的合成前后对照；当前独立试点仍固定v0.15，不混入本版，也不据此宣称竞品优势。

## 0.16.0 — 开发候选，2026-10-29

- 无主题细节的工具写入、自动捕获与本地采纳改用“索引摘要”标记，避免生成指向不存在文件的引用；有实际细节时保留主题引用，不创建占位文件或复制摘要来伪造细节。
- 原库不自动改写；格式别名重复保留已有条目及ID，候选再审核/撤回识别旧格式，遇到两种有效格式并存时拒绝歧义。新旧格式的取代关系、过期和来源撤回均保留。
- 旧索引的缺失主题引用在注入时诊断，仅检查文件属性和权限；新增10项回归及实际v0.15旧写入器生成的兼容夹具，补验自动捕获的有/无细节分流。独立试点继续固定使用v0.15.0，不把新候选混入既有试点。

## 0.15.0 — 开发候选，2026-10-29

- 真实默认自动捕获已写入全局偏好，但新会话的默认项目检索连续漏查。memory_search 默认改为当前项目和全局联合检索，统一相关性排序及输出预算，命中标明作用域；不读其他项目，显式单库及写入等工具的默认行为保留。
- 新增联合检索的项目隔离、同名文件归属、统一排序/预算和未完成发布阻断回归。真实模型合成开发例与独立比较分开记录，不据此声称优于竞品。

## 0.14.0 — 开发候选，2026-10-29

- 实际原生模型工具循环发现memory_write写入成功后，其结果携带undefined可选字段，被宿主判作非无损JSON；模型收到错误可能误导重试。首次、重复及取代写入改为仅在有值时返回可选字段。
- memory_links的两个可选版本链字段采用同一返回约定，避免无取代关系的正常查询被宿主拒绝。保留实际字段值、版本关系和存储格式，不对全部输出做宽松JSON强制转换。
- 新增六项工具结果回归，覆盖首次/重复/细节/取代写入、版本查询及六工具生命周期。原生宿主、安装包及受控历史维护结果另行记录；独立真实模型质量和公开发布目标仍未完成。

## 0.13.0 — 开发候选，2026-10-29

- 捕获参数在宿主已绑定的模型能力回调内选择：支持off则关闭，普通模型省略，不支持off的模型保留宿主默认；流请求直接使用准备句柄控制值，避免强行覆盖导致拒绝。每次抽取仍只准备一次，不另查能力或通过失败重发试探。
- 准备期能力错误记录固定码，流期同名错误不冒充准备失败，异常正文不持久化；升级不自动重发旧失败或未决输入。新增错误码的旧版降级兼容及推理成本边界写入说明。
- 修复显式捕获provider/model被主会话模型覆盖的问题，原会话恢复及来源复查采用同一优先级；不完整或空白显式路由暂停捕获，六工具及已有注入保持。
- 源码、实际宿主与安装包证据另行记录；公开第一版及独立优势目标未完成。

## 0.12.0 — 开发候选，2026-10-29

- 新增不复制正文的持久来源引用队列，原会话恢复时经宿主异步读平面核对消息/范围/配置后补跑未领取工作；子代理、种子和继承历史不准入。已领取或未知调用不重发，覆盖领取与绑定之间的中断窗口。
- 模型准备后发送前及发布前重新核对活动来源、撤回与版本；提供只读查看、双版本预览后终态引用清理，保留待处理和未决输入。原日志/队列无跨文件事务，压缩或来源不可用时不保证恢复；没有外部结果对账、自动模型重试/退避或全部旧会话扫描。
- 453项源码回归、隔离加载及既有评测/可用性检查通过；实际宿主中断恢复和安装包证据另行记录。第一版公开发布及独立优势目标未完成。

## 0.11.0 — 开发候选，2026-10-29

- 真实隔离宿主复现：撤回后最新记忆视图虽已更新，旧运行时快照仍出现在同会话下一次模型请求中。新增按来源替换历史记忆节，保留其他插件、普通对话和原始日志；投影检查点仅存消息身份与序号。
- 步骤和请求边界清理旧节，发送前检查当前库；归因不明、渲染不一致、映射缺失、超限或替换失败时明确阻断。未清理普通对话/已形成摘要中的复述、远端缓存或所有备份，不宣称完整遗忘。
- 纠正“动态记忆不进入历史/不参与压缩”的旧说明；provider渲染单测不能证明真实宿主行为。公开发布及独立优势目标仍未完成。

## 0.10.0 — 开发候选，2026-10-29

- 新增未决捕获的人工关闭入口：默认只读预览，显式应用需账本版本核对；状态为 abandoned，外部结果保持未知，不重发请求或回滚已写记忆。运行中有效租约不能关闭，旧结果不能借此恢复发布。
- 关闭的身份可按原容量策略老化，保留期间不重领；旧版插件遇到新状态会暂停自动捕获并保留现场，不能把关闭当作可安全重试。
- 修正安装包探针继承父环境的问题：打包、回归、安装及真实宿主均使用最小环境与临时 home/tmp，增加真实子进程凭据/加载钩子不继承检查。v0.9.0 报告中对该包探针“未继承凭据”的描述过强，已在开发证据中纠正。

## 0.9.0 — 开发候选，2026-10-29

- 冷启动开发探针发现默认精确检索漏掉多数多词查询；默认改为 ranked，显式 exact 保留原子串定位。v0.8.0 不利结果与安装包保留，没有用新结果覆盖旧版本。
- 排序特征加入有限英文规则词形归并；不改原文或结构化标识符，不宣称完整词干分析。相同词形归并后只计一个词元，不能绕过两词元支持闸。
- 新增五项检索回归，含无中英词元时的 Unicode 字面定位，避免默认排序丢掉日文、韩文等原有精确命中。基线原有测试、实际宿主加载和跨进程开发合同单独保留，不计入本插件测试总数，也不视为独立留出或产品胜出。
- 源码加载探针改为最小全新配置，不复制私人 profile 或继承凭据；没有宿主时明确失败。加载检查等待包含版本和工具列表的最终标记，避免把预备 pid 标记当成就绪状态。
- 尚未部署桌面、运行付费模型比较或公开发布。自然工作流、任务续跑与独立客观优势验收继续进行。

## 0.8.0 — 开发候选，2026-10-29

- 请求前持久化调用身份哈希和短租约；同快照在保留期间重开/并发不会重复领取，过期工作者输出拒绝。账本不含消息、提示词、模型路由或候选正文。
- 崩溃遗留和过期调用标为未决，不自动重发；本地诊断 CLI 默认只读，recover --apply 仅更新状态。256 条容量保留运行中/未决记录，账本损坏时暂停捕获但保留六工具与注入。
- 修复只有 AbortSignal 的软超时：不合作 provider 的准备与流等待现在有本地硬超时；迟到准备不再启动模型流。
- 修复新用户空列表配置安装后无效的 YAML，卸载可恢复原注释/空白；插件路径按标准 file URL 编码。增加真实离线打包与全新配置安装探针，内部研究、历史对话设计与个人路径记录不进入发布包。
- 增加锁前占用的明确错误码与最多三次本地写入重试，租约/版本变化和未知执行结果不重试，不重发模型请求；并发测试等待所有工作进程，避免清理掩盖初始错误。
- DSH 自带 Node v24.21.0 的回归、隔离加载、既有评测/可用性与实际安装包验证另行记录，不以单次通过代替压力复测。
- 这不是自动续跑队列；退避、原会话取证重建、重试和未决处置仍待实现。未部署桌面、未运行真实付费抽取、未公开发布。

## 0.7.0 — 开发候选，2026-10-29

- 增加受管来源撤回：默认预览、双版本校验，索引/受管细节/候选/关联审计历史正文同一可恢复计划清理；不删除无关内容。
- 新采纳细节带候选标记；保留撤回内容哈希及块长度与哈希，防派生文件旧副本重新进入记忆输出；同根重入拒绝，新根复述进入复审，可显式重新确认。有效行另有独立采纳来源时拒绝自动删除。
- 旧自动摘要仅在消息级审计来源明确时支持；无标记旧细节、消息来源缺失、文件分歧或损坏均拒绝，避免假清除。
- 状态工具 recent 改为净化的操作元数据，并补齐输出 schema，避免旧审计正文经状态接口返回。
- 文件读取默认 512 KiB 不变，仅恢复计划中的已知日志允许上限 2 MiB，仍拒绝链接/非普通文件与超限；发布目标仍是固定白名单。
- DSH 自带 Node v24.21.0 下 375 项回归、隔离加载、既有评测与可用性门禁通过；新增 22 项测试。记录见 VERIFICATION-0.7.0.md。
- 第一版发布、完整备份/跨项目撤回、后台任务续跑和独立留出优势验证仍未完成；本轮未部署桌面或改真实记忆。

## 0.6.0 — 开发候选，2026-10-29

- 候选采纳默认只预览，显式提交须带当前索引哈希与候选箱版本；过期审批、拒绝/撤回、跨范围候选被拒绝。
- 写入增加可恢复发布日志：固定目标白名单、受限阶段文件、前后内容哈希；索引/主题细节/候选状态中断后可 roll-forward。未恢复库暂不注入、检索或接受普通写入。
- 本地 candidates recover 默认核查，--apply 才恢复；外部编辑和阶段损坏保留现场。不自动覆盖冲突。
- 历史 insert/supersede 改到发布成功后记录，避免拒写也留下成功历史；恢复有独立审计，但历史/关系重建仍未完成。
- 新增 17 项专项测试，累计 353 项回归与隔离加载/评测/可用性门禁通过。桌面仍为 v0.4.1，尚未部署、发布或完成对比胜出验证。

## 0.5.0 — 开发候选，2026-10-29

- inferred 候选从轮转审计移到独立 `.candidates.json`；审计只记候选 ID/状态，默认不注入、不自动采纳。
- 新增本地候选查看、拒绝、按来源撤回和默认 dry-run 清理；保留拒绝/撤回标记，阻断同候选或同来源改写重入。容量与标记数有界，损坏文件保留现场。
- 原子写临时文件改随机名与独占创建，写后 fsync，失败清理正文；新增可预测临时链接劫持回归。
- 候选功能和自动捕获接线已在隔离库测试；桌面仍为 v0.4.1，未迁移历史审计或部署候选。
- 该版不含候选采纳、有效记忆跨库撤回、完整事务和持久化作业恢复；不报告已达到发布门槛或胜过社区插件。

## 0.4.3 — 开发候选，2026-10-29

- `memory_search` 新增可选 ranked 模式：中文双字与拉丁词元、按库区分度加权、弱单词召回闸、精确命中优先；exact 仍为默认，出口净化与大小上限保留。独立实现，无社区代码移植。
- 316 项本地回归与隔离加载/评测/可用性检查通过；桌面仍为 v0.4.1。
- 运行固定 topics-memory 源码的 29 项上游原有检索/净化测试，全部通过；独立 HOME/DSH_HOME，无依赖安装。
- 开发组件探针原精确模式 6/12，ranked 12/12，基线 10/12；p=0.25，非留出、非完整产品赛马，不支持优势声明。保留原始落后结果。

## 0.4.2 — 开发候选，2026-10-29

- 后台自动捕获新增按库索引 SHA-256 版本检查：在写锁内拒绝基于旧索引的候选，同批次自身写入推进令牌，人工更改或删除后不能用旧令牌发布。
- 新增配对统计分析器：场景级精确符号检验，拒绝重复编号、不配对与缺失评分，不把同一场景复跑伪装成独立样本。
- 根据真实 v4 日志确认用户消息携带 data.source.kind=user，未知来源不再默认当用户，runtime-context 召回禁止进入用户证据窗口。
- 新增 8 项回归，累计 312 项；最终结果见 release/verify-0.4.2.txt。用户桌面仍为 v0.4.1，当前开发候选没有部署或发布。
- 固定 Codex、OpenClaw 原文快照与四套社区基线 commit；新增 RELEASE-V1.md，列出发布缺口和比较协议，未报告未经运行的优势。

## 0.4.1 — 2026-10-29

- 真实 v0.4.0 捕获暴露 `capture-invalid-json` 后，核对宿主流协议发现旧 chunkText 会把 `reasoning-delta.text` 拼进最终答案；修为忽略推理片段与 block-end。
- 简短后台抽取显式关闭 reasoning；识别 finish 的 max-tokens/error/aborted，并区分空响应，均不当成功处理。
- 新增 3 项宿主流协议回归；真实负例复测结果单独记录。

## 0.4.0 — 2026-10-29

- 自动捕获保留发言角色与消息定位，必须核对用户原话；写入审计附来源与哈希。
- 分开 `explicit` 和 `inferred`：后者只记候选审计，不作为有效长期记忆注入。
- 支持项目内条件偏好，缺失项目目录时拒绝项目候选；去重输入同时读取全局和项目索引。
- 提示词排除临时进度、助手完成声明及从单次任务归纳的长期习惯。
- 抽取输入默认限 24 KiB，调用前打码；错误码与最终 running 状态立即落盘，坏 JSON 不再伪装成空成功。
- 新增 18 项回归测试；完整结果见本轮 VERIFICATION 记录。
- 文档加入 Codex、三套 dsh 社区插件、OpenClaw 与 POMDP 的证据级别和渐进路线。未安装第三方插件，未迁移真实记忆。

## 0.3.2 — 2026-10-28

- 自动捕获触发阈值 12 → 4 轮（先让它跑起来，再按真实质量调）
- 新增 `.capture-state.json`：记录「收到多少会话事件、算到第几轮、上次触发时间」。
  上一轮等了半天才发现根本没触发——可观测性不能省。
- 探测版探针证实：`listProviders()` 在 CLI 实例里为空，路由必须从会话 `request/header` 取


## 0.3.1 — 2026-10-28

- 修：自动捕获拿不到模型路由。`listProviders()` 在 CLI 实例里为空（适配器按会话注册），
  改为从会话自身的 `request/header` 事件读 `provider`/`model`
- 修：`pickRoute` 忘了 await（`listProviders` 是 `@Remote` 异步方法）


## 0.3.0 — 2026-10-28

自动捕获：不用用户开口，系统自己记。

- 新增 `capture.mjs` / `capture-llm.mjs`：每 12 轮让宿主模型整理一次记忆，候选经既有写入闸入库
- 按类型分库：`user`/`feedback` → 全局库，`project` → 项目库
- `ctx.reflect.get('llm', false)` 取宿主模型服务（cordis 未声明 inject 时直接读会抛）
- 路由解析 `pickRoute()`：兼容 provider 列表的多种形状，拿不到就不猜
- 失败路径只写审计（`op:capture`），不影响主流程
- 加载痕迹里记录 `autoCapture` 状态，重启后可直接看出有没有生效
- 测试 274 → 283


## 0.2.0 — 2026-10-25

可用性版本：把「写入会撞墙」这个死路去掉。

- 新增 `memory_search`：在索引与主题文件里检索；索引被截断时仍能找回旧条目
- 新增 `memory_prune`：删过期、合并重复、压到上限（留 20 行余量）、轮转超大主题文件；默认 dry-run
- 新增 `memory_status`：条数/行数/字节/过期/重复组/主题文件大小的只读快照
- `memory_forget` 支持 `expired: true` 批量删过期
- 写入/配额/主题文件超限的错误信息改为给出**已存在**的下一步（`memory_prune`）
- 冲突检测改为提示（同一事实不同取值），不拦截
- 修：`checkIndexBudget` 的尾行 off-by-one（压到 300 行仍被拒）
- 修：`conflictSignature` 忽略占位符两侧空白（「26 集」与「26集」判成两条）
- 工具 `memory_compact` 改名 `memory_prune`，避免与宿主 `/compact`（对话压缩）混淆
- 新增 `test-compaction-compat.mjs`（13 项）：验证与宿主对话压缩的四个接触面
- `memory_links` 输出有界（出边/入边各 10 条，另报总数），防止被宿主的工具结果修剪截断
- 修（严重）：`memory_status` 的 output schema 用了 `additionalProperties: {type:'integer'}`，
  宿主注册时抛 `JsonSchemaError`，**整个插件静默不加载**。改成闭合对象。
- 新增 `test-schema.mjs`：把宿主的三条 schema 规则搬进测试（单元测试绕过注册校验，之前测不到）
- 新增 `scripts/probe-load.mjs`：隔离实例真加载探针，已接进 `verify.mjs`
- 加载痕迹改为**无条件写入**（之前藏在诊断开关后面，导致 A2 永远无法通过）
- 测试 226 → 274

## 0.1.0 — 2026-10-25

首个可用版本。

- 索引自动注入（provider 同步产出，绕过 `refreshContext` 覆盖问题）
- 按项目分库，项目根按 git / `.dsh-root` 向上查找
- `memory_write` / `memory_forget` / `memory_links` 三个工具，手写 schema（不依赖 defineTool）
- supersede 语义 + 历史链 + 内容寻址 id + 关系边继承
- 安全：框架定界符中和（含同形字/全角）、不可见字符剥离、凭据拒绝与打码、符号链接拒绝、0700/0600、跨进程锁、审计
- 生命周期：索引 200 行 / 25 KB、库配额 2 MB、过期标记 `(exp:YYYY-MM-DD)`
- 测试 226 项；评测框架（逃逸率消融、写入精确率、召回成本、fuzz、气味检测三套数据）
