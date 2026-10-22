# Continuous integration

The CI workflow validates pull requests and pushes to `main`, and supports manual runs. Windows and Linux jobs use the same pinned Node.js and npm versions and install dependencies from the lockfile with `npm ci`.

Checks cover the core conversion and validation engines, archive safety, offline viewer, responsive workbench, native Electron integration, publication privacy, and packaged native command-line execution. All conversation fixtures are synthetic. A separate dependency audit checks the complete locked dependency graph.

The platform jobs create unpacked applications for testing. CI does not create tags, GitHub releases, installers, or downloadable release packages. Publishing is a separately approved activity.

## Workflow permissions

Workflows request read access to repository contents. They use GitHub-owned actions pinned to complete commit hashes, disable persisted checkout credentials, and do not use personal access tokens. Pull request code is never executed through `pull_request_target`.

Dependabot proposes npm and GitHub Actions updates. Updates require review and successful validation; they do not merge automatically. Keep exact dependency versions and the lockfile consistent when accepting updates.

## Maintainer checks

Before merging, inspect the `Test and build (Linux)`, `Test and build (Windows)`, and `Dependency audit` results for the exact proposed commit. A successful cross-build does not replace the native Windows check.

Keep repository visibility private until the publication review is complete. Enable required status checks and disallow branch deletion and force pushes when the account plan supports protection of private repositories. If GitHub cannot enforce these rules, successful checks remain a maintainer requirement rather than a server-enforced gate.

GitHub's private vulnerability reporting and some hosted security features depend on repository visibility and account entitlements. The presence of `SECURITY.md` does not imply that those features are enabled. Review their availability when changing visibility; never change visibility merely to enable a feature.

Never upload genuine exports, local settings, authentication helpers, or diagnostic files containing private data as CI artifacts. Review failure logs before sharing them outside the repository.
