# Changelog

## 1.1.0 — Export-format compatibility

- Accept current exports with numbered conversation JSON parts, modern `index.html`, or no `chat.html`; select a consistent export root, including nested folders.
- Recreate missing `chat.html` from original, unconverted JSON while keeping transformed output in `chat-index.html`; preserve an existing original `chat.html` byte for byte.
- Include matching exported `.dat` attachments as local download links in generated viewers, preserving their bytes in the output and processed bundle, covering them with the checksum manifest, and making no automatic remote requests.
- Add synthetic regression coverage for current export structures and archive safety.
- Update the build runtime to Node.js 26.13.0 LTS, Electron 45.2.3, and electron-builder 26.18.0; pin patched minimatch dependencies to address the audited advisory.
- Include marked 18.1.2 and Playwright 1.65.0, and constrain release-tool paths to the checkout's build files.
- Install a native Debian entrypoint in `/usr/bin` and retain the native executable at the Linux portable archive root.
- Publish release packages, exact-tree source archives, and one SHA-256 manifest only after native platform verification and dependency checks pass.

## 1.0.0 — Initial public edition

- Added a redesigned desktop workbench for local ChatGPT export conversion and read-only inspection.
- Integrated independent conversion-rule checks, content-preservation validation, findings, and schema review.
- Added explicit passed, review-needed, failed, and limited-coverage results.
- Added JSON, HTML, and CSV inspection report export.
- Established an independent application identity and appearance preferences.
- Kept conversion and inspection local, without network deployment functionality.
- Added synthetic regression coverage, source privacy checks, locked dependencies, and native packaging contracts.

- Added native Windows and Linux CI, release archive checks, and Debian installation/removal verification.
