# Continuous integration

The CI workflow validates pull requests and pushes to `master`, and supports manual runs. Windows and Linux jobs use the same pinned Node.js and npm versions and install dependencies from the lockfile with `npm ci`.

Checks cover the core conversion and validation engines, archive safety, offline viewer, responsive workbench, native Electron integration, publication privacy, and packaged native command-line execution. All conversation fixtures are synthetic. A separate dependency audit checks the complete locked dependency graph.

The platform jobs create unpacked applications for testing. CI does not create tags, GitHub releases, installers, or downloadable release packages. Publishing is a separately approved activity.

The manually dispatched **Release build** workflow creates distributable archives and a Debian package from the selected commit. It verifies extracted packages, runs the packaged application, and exercises Debian installation and removal before uploading build artifacts. A fresh Windows runner downloads that run's portable ZIP and tests its first launch before starting any other Electron application. It also checks 120 isolated version, help, and invalid-command launches under bounded parallel load, requiring the expected output and exit status every time without retries. These artifacts are staging inputs for a release, not automatically published releases. Source archives must come from the same committed tree, and the final release uses one consolidated `SHA256SUM.txt`.

## Workflow permissions

Workflows request read access to repository contents. They use GitHub-owned actions pinned to complete commit hashes, disable persisted checkout credentials, and do not use personal access tokens. Pull request code is never executed through `pull_request_target`.

Dependabot proposes npm and GitHub Actions updates. Updates require review and successful validation; they do not merge automatically. Keep exact dependency versions and the lockfile consistent when accepting updates.

## Maintainer checks

Before merging, inspect the `Test and build (Linux)`, `Test and build (Windows)`, and `Dependency audit` results for the exact proposed commit. A successful cross-build does not replace the native Windows check.

Require these checks on pull requests, disallow branch deletion and force pushes, require resolved review conversations, and retain a linear `master` history. A sole maintainer can use a zero-approval pull request rule while still requiring successful checks. Publication of a new repository requires a separate privacy review of its complete history, release files, and metadata.

GitHub's private vulnerability reporting and some hosted security features depend on repository visibility and account entitlements. The presence of `SECURITY.md` does not imply that those features are enabled. Review their availability when changing visibility; never change visibility merely to enable a feature.

Never upload genuine exports, local settings, authentication helpers, or diagnostic files containing private data as CI artifacts. Review failure logs before sharing them outside the repository.
