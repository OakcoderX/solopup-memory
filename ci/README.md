# Release and compatibility automation

The active workflows are in `.github/workflows/`:

- `compatibility.yml`: source/CI tests and the explicitly configured DSH host matrix.
- `publish.yml`: tested immutable archive, npm beta publication through OIDC,
  GitHub prerelease, self-hosted index/current-release document synchronization,
  and a read-only audit of existing public entry points.
- `version-sync.yml`: a manual read-only recheck, with a report artifact.

See [RELEASING.md](RELEASING.md) for authorization boundaries, recovery, npm tag
semantics and the distinction between mechanical gates and actual host/model
acceptance. Merely checking in a workflow does not prove that a run passed.

`github-actions-test.yml` is a historical optional template, not an enabled workflow.
`node --test ci/*.test.mjs` exercises the release and audit guards without publishing.
