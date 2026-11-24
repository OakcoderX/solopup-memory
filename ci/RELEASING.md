# Automated SoloPup releases

The npm trusted publisher must bind `solopup-memory` to:

- GitHub owner: `OakcoderX`
- Repository: `solopup-memory`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Permission: direct `npm publish` (stage-only would still require manual approval)

The workflow uses GitHub-hosted runners and OIDC. It needs no stored npm write
token. A first successful actual publish must validate a new binding within two
days, according to npm's current policy.

Update package.json, version.mjs and CHANGELOG.md. Preview tags must be
reachable from main. A stable tag must point at the matching
`release/<version>` branch descended from main, so the new default
installation instructions can wait there until the npm release is verified.
Every tag must exactly match the package version. A beta goes to `beta`, a release candidate goes to `next`, and a
stable version goes to `latest`. The npm environment must allow the intended
release tag. Release candidates do not alter the default market entry.

Before pushing a stable tag, build the final archive with the workflow's npm
version, and test that archive on the supported desktop DSH with a real model.
Commit the sanitized receipt at `release-evidence/<version>.json`. It must
identify the version, archive SHA-256, host, model and number of model calls,
and confirm upgrade, rollback, current rule and exception, withdrawal and
workspace scope, and positive and negative delivery checks. This receipt is
kept outside the npm archive so adding it cannot change the tested bytes.
The workflow refuses to publish a stable archive with a missing or mismatched
receipt.

The pipeline runs source tests on Linux and macOS, tests the actual packed
archive, and runs the DSH long-history probe against those exact archive bytes.
The publisher requires the passing probe receipt to match the archive digest.
It waits
for the public npm download and checks SHA256/SHA512. Identical already-published
versions are verified without republishing; a different immutable version fails.
After the archive and expected dist-tag are verified, it creates the GitHub
release. Stable releases fast-forward main to the tested release and update the
repository-managed market index.
Once a stable entry exists, preview releases leave the default entry alone.

All correctness gates block on both platforms. Shared Linux and Mac runners
both showed absolute timing variation above the original local Mac 5ms budget.
Hosted CI therefore compares three paired baseline/candidate runs on the same
machine against the immutable beta.3 archive (SHA256 pinned in eval-gate.mjs).
It blocks median regressions above 25 percent or 0.25ms scheduling allowance.
Raw absolute 5ms misses remain explicit in release receipts; they are not called
passes. The separate local Mac gate and its 5ms threshold remain unchanged.

For a rehearsal, manually run **Publish SoloPup Memory** with `dry_run=true` and blank
tag. No npm publish, GitHub release or market mutation occurs. For recovery,
rerun the same release tag; do not delete a published npm version. A failed
registry-propagation check requires status inspection, not another publish.

Retries and manual recovery do not submit a publicly missing version again by
default: 404 can mean registry scanning is still pending. Inspect authenticated
npm version status first. Only if it confirms no submission, dispatch on the
existing version tag with `dry_run=false` and `confirm_unsubmitted=true`. An already
public identical version is verified without another upload. Dispatch a release
with the GitHub ref set to that version tag. The npm environment refuses main refs.

GitHub environment `npm` permits version tags, and the npm publisher must name
that same environment. Only the publish job receives `id-token: write`; the
separate GitHub/market job receives repository write permission. Account changes
and changes to this trust configuration may still require the owner's security
key. Do not enable a broad 2FA bypass or store account credentials in the repo.
