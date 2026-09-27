# Publish a locally verified build

The user authorized publishing after equivalent local checks and browser
verification. The manual `Publish locally verified build` workflow builds and
deploys that exact commit without repeating the full crypto and network
simulation suites on the deployment path. Normal CI still runs independently.

Before dispatching, record the local type, lint, format, dependency, purity,
translation, test and production-build results. Verify the affected browser
flows. Fix failed checks before publishing. Expensive acceptance tests can stay
opt-in when their passing evidence is already recorded for the implementation.

Commit the verified source, push it to `main`, and run:

```sh
gh workflow run pages-verified.yml --ref main -f verified_sha="$(git rev-parse HEAD)"
```

The workflow rejects a revision that differs from its checkout. Its completion
means the build was published, not that remote CI or the full milestones passed.
After deployment, verify the actual Pages home screen, multiplayer entry routes
and loaded assets. Keep any remaining release limitations in the verification
record.
