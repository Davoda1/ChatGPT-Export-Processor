# Continuous integration and releases

The CI workflow validates pull requests and pushes to `master`, and supports manual runs and reusable workflow calls. Windows and Linux jobs use the same pinned Node.js and npm versions and install dependencies from the lockfile with `npm ci`. Ordinary branch check names remain `Test and build (Linux)`, `Test and build (Windows)`, and `Dependency audit`.

Checks cover the core conversion and validation engines, archive safety, offline viewer, responsive workbench, native Electron integration, publication privacy, and packaged native command-line execution. All conversation fixtures are synthetic. A separate dependency audit checks the complete locked dependency graph.

## Release verification and publication

A version change merged into `master` runs the release workflow. Master pushes affecting package metadata are skipped when that version already has a tag, so later dependency maintenance does not republish an existing version. Pushing a `v*` tag also runs release verification. Manual dispatch defaults to verification only and has an explicit publish option. A release must come from a clean committed tree reachable from `master`; its version tag is created only after verification, or an existing tag must identify that exact commit.

The release workflow directly calls CI and the dependency audit for its own commit. After both pass, it creates Windows and Linux packages, verifies extracted files, tests native application startup and conversion, checks Windows version/maintainer metadata, and exercises Debian installation and removal. A fresh Windows runner then downloads that run's portable ZIP and tests its first launch before starting another Electron application. It also checks 120 isolated version, help, and invalid-command launches under bounded parallel load without retries.

Only after all these jobs pass does the publication job download the same run's three binary assets. It creates source ZIP and tar.gz archives from the exact Git tree and a single `SHA256SUM.txt` covering all five downloads. Publication creates the version tag if missing, stages a draft, verifies the complete uploaded asset inventory and sizes (and server digests when provided), then makes the release public. An incomplete upload remains a draft. An existing public release is never replaced; a draft can be resumed only when it targets the same commit and contains no unrelated assets.

The local build commands do not publish. Manual verification-only runs leave artifacts for review. No external workflow polling is used: dependency, source, package, and cold-start checks are dependencies in the same release run.

## Workflow permissions

Validation and packaging request read access to repository contents. Only the final gated publication job receives `contents: write`; it uses the short-lived Actions token. Workflows use GitHub-owned actions pinned to complete commit hashes and disable persisted checkout credentials. They do not use personal access tokens, and pull request code is never executed through `pull_request_target`.

Dependabot proposes npm and GitHub Actions updates. Updates require review and successful validation; they do not merge automatically. Keep exact dependency versions and the lockfile consistent when accepting updates.

## Maintainer checks

Keep required pull-request checks, branch deletion/force-push protection, resolved review requirements, linear `master` history, and release-tag protections in place. A release workflow's success describes its exact source commit; checks for a different commit do not satisfy its gates.

GitHub's private vulnerability reporting and some hosted security features depend on repository visibility and account entitlements. The presence of `SECURITY.md` does not imply that those features are enabled. Review availability when changing visibility; never change visibility merely to enable a feature.

Never upload genuine exports, local settings, authentication helpers, or diagnostic files containing private data as CI artifacts. Review failure logs before sharing them outside the repository.
