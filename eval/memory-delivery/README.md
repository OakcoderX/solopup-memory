# SoloPup memory delivery evaluation

Run from a source checkout on Apple silicon with Node 24+, Python 3, and DeepSeek Harness 0.2.2-rc.3 installed in Applications. The runner creates separate DSH homes and checkouts in a private temporary directory. It confines the task process to its checkout and temporary data and relays the model request through a local endpoint.

## Two small tasks

1. Obtain the public `solopup-memory@0.25.0-beta.2` archive and pack the candidate from source using `npm pack --ignore-scripts`.
2. Run the stage command with absolute archive paths and the candidate's SHA-256. It prints the experiment directory.

```sh
python3 eval/memory-delivery/compare.py stage \
  --baseline /path/to/solopup-memory-0.25.0-beta.2.tgz \
  --candidate /path/to/solopup-memory-0.26.0-beta.1.tgz \
  --candidate-sha CHECKSUM --candidate-version 0.26.0-beta.1
```

3. Run `python3 eval/memory-delivery/compare.py run LAB_DIRECTORY` for the fixed-response host check. Stage a fresh directory for the real-model comparison.
4. To run with DeepSeek Flash, append `--live` to the run command and supply an authorized DeepSeek API key on standard input. This makes billable model calls. Do not put a key in a prompt, command-line argument, or receipt. All arms share the same model options and time budget.
5. Read `receipts.json`. The runner freezes exact output patches. It scores main-task success and compliance with the latest convention from the produced artifacts.

The cases and checks are visible here for reproducibility. A future comparison should freeze new cases before modifying the plugin.

## Official cattrs task

Get `cattrs-compositional-changelog` through Harbor Hub's published `letta-ai/frontier-memory@v1.0` dataset. Verify its pinned agent image source tree and task prompt against `cattrs-base.json`. Acquire the public trajectory pages named in `cattrs-sources.json` and save each as its URL slug plus `.html`. Run `cattrs-inputs.py HTML_DIRECTORY INSTRUCTION_MD OUTPUT_DIRECTORY`, then pass `--cattrs-inputs OUTPUT_DIRECTORY --cattrs-source CLEAN_CATTRS_GIT_CHECKOUT` to the stage command. Both memory arms receive the same source-backed, reviewed records. The full historical transcript stays available as a reference.

Each live cattrs arm receives 1,200 seconds. Transfer each frozen patch to an isolated Linux Harbor environment. Use `pair_patch_agent.py` to apply the patch to the official task environment and `read_pair_result.py` to collect the result from the unchanged verifier. `grade-frozen-patch.sh` shows the invocation used in the disposable Linux guest and verifies the key task file digests. Record the strict score, separate feature and regression counts, and preference checks. Keep API credentials, raw model messages, and private session files out of release artifacts.

[FrontierMemory rules](https://github.com/letta-ai/frontiermemory/blob/main/docs/rules.md) · [SoloPup report](../../docs/runs/2026-11-18-memory-delivery.md)
