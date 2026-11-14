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
After verification it creates the GitHub prerelease and updates this repository's
self-hosted market index on main. It does not claim central-market approval,
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

Retries and manual recovery do not submit a publicly missing version again by
default: 404 can mean registry scanning is still pending. Inspect authenticated
npm version status first. Only if it confirms no submission, dispatch on the
existing beta tag with `dry_run=false` and `confirm_unsubmitted=true`. An already
public identical version is verified without another upload. Dispatch a release
with the GitHub ref set to that beta tag; the npm environment refuses main refs.

GitHub environment `npm` permits version tags, and the npm publisher must name
that same environment. Only the publish job receives `id-token: write`; the
separate GitHub/market job receives repository write permission. Account changes
and changes to this trust configuration may still require the owner's security
key. Do not enable a broad 2FA bypass or store account credentials in the repo.

## Version entry points and post-release checks

The three primary install guides use `solopup-memory@beta`, not an unqualified
package name. This is resolved when installing; it does not automatically upgrade
an existing installation. Publishing with `--tag beta` moves that npm tag before
the public-download verification finishes. Therefore `@beta` is a moving channel,
not a promise that every release or host/model combination has already passed
acceptance. Bare `solopup-memory` resolves the separate npm `latest` tag.

The finalization step binds version, repository, tag, source commit, filename and
both archive digests to the successful public-download receipt. It then generates
`docs/releases/current-beta.md` with the exact install command and evidence links,
and numerically sorts `market/index.json` without duplicate versions. Historical
reports and changelogs are not rewritten. Managed install blocks must still match
their checked-in template; a manual edit stops synchronization instead of being
overwritten. Changes outside those blocks are preserved.

All beta release runs share one concurrency group. GitHub concurrency retains at
most one pending run; do not push a burst of beta tags expecting a durable queue.
Wait for the active release to finish and inspect any cancelled pending run before
creating another release. An older release cannot move
`beta` backwards; a replay that no longer matches the public beta stops before
changing the current guide. The publisher reads `latest` before and after its
work and fails on a change or uncertainty. It never writes, restores or promotes
`latest`. A concurrent unrelated tag change requires human inspection. The final
git push is an ordinary fast-forward push: if main advances, inspect the current
branch and retry only the appropriate finalization, without force-pushing or
republishing an immutable npm version.

After the publish job succeeds, the read-only `version-audit` job consumes the
same verified release artifact, even if finalization fails. It compares public registry metadata and existing
promotion entry points in `ci/promotion-channels.json`, and uploads JSON/Markdown
reports as `public-beta-version-sync` (30-day retention). This allowlist contains
only public existing entries; it does not replace or expose the private promotion
worklist. A maintainer can run **Audit public beta entry points** manually for a
later check. That standalone check downloads the public release evidence, so a
blocked/missing receipt is reported as unverified rather than assumed current.

For local read-only checks:

```sh
node --test ci/*.test.mjs
node ci/promotion-audit.mjs
# Or use the verified-published-release artifact from that same release run:
node ci/promotion-audit.mjs --receipt-dir release
```

Reports are written to `release/version-sync/report.json` and `report.md`, and to
the Actions summary when available. HTTP 401/403/429 are blocked, network or schema
changes are unknown, and matching metadata is not an installation test. A catalog
tarball, manifest version and npm install target are separate observations; changing
one does not guarantee the other follows it. Directory discovery does not prove
compatibility or adoption. Receipt failure fails the audit job; individual channel
findings remain explicit in its report and do not roll back an already-published
release. An audit failure never means it is safe to publish again.
If the publish job fails after an upload was accepted but before its receipt was
saved, this audit cannot bind that incomplete run. Inspect npm submission state
and the existing promotion follow-up instead; do not assume nothing was published.

There are no automatic third-party writes. Review existing discussions/requests
and the promotion worklist first, then make only necessary authorized corrections
to original entries. Track the existing 1024 issue #36 and the Awesome correction
branch; do not create duplicate submissions or retry/bypass a prior permission
denial. Third-party refresh schedules, maintainer decisions and API availability
cannot be guaranteed by this workflow. Scheduled human/assistant follow-up remains
separate from this repository's read-only audit.
