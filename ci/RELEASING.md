# Automated public-beta releases

The npm trusted publisher must bind `solopup-memory` to:

- GitHub owner: `OakcoderX`
- Repository: `solopup-memory`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Permission: direct `npm publish` (stage-only would still require manual approval)

The workflow uses GitHub-hosted runners and OIDC. It needs no stored npm write
token. A first successful actual publish must validate a new binding within two
days, according to npm's current policy.

Prepare the next beta on main: update package.json, version.mjs and CHANGELOG.md;
perform the actual local DSH/archive acceptance separately. Commit the changes,
then push the matching `vX.Y.Z-beta.N` tag. Only beta versions reachable from
main are accepted. Stable releases are deliberately outside this automation.

The pipeline runs source tests on Linux and macOS, tests the actual packed
archive, and passes that immutable artifact to the OIDC publishing job. It waits
for the public npm download and checks SHA256/SHA512. Identical already-published
versions are verified without republishing; a different immutable version fails.
After verification it creates the GitHub prerelease and updates the configured
third-party market index on main. It does not claim central-market approval,
stable semantic acceptance, actual user adoption, or historical data erasure.

All correctness gates block on both platforms. Shared Linux and Mac runners
both showed absolute timing variation above the original local Mac 5ms budget.
Hosted CI therefore compares three paired baseline/candidate runs on the same
machine against the immutable beta.3 archive (SHA256 pinned in eval-gate.mjs).
It blocks median regressions above 25 percent or 0.25ms scheduling allowance.
Raw absolute 5ms misses remain explicit in release receipts; they are not called
passes. The separate local Mac gate and its 5ms threshold remain unchanged.

For a rehearsal, manually run **Publish npm beta** with `dry_run=true` and blank
tag. No npm publish, GitHub release or market mutation occurs. For recovery,
rerun the same release tag; do not delete a published npm version. A failed
registry-propagation check requires status inspection, not another publish.

GitHub environment `npm` permits version tags, and the npm publisher must name
that same environment. Only the publish job receives `id-token: write`; the
separate GitHub/market job receives repository write permission. Account changes
and changes to this trust configuration may still require the owner's security
key. Do not enable a broad 2FA bypass or store account credentials in the repo.
