# Building and verification

Use Node.js 24 and npm 11 with the included lockfile. `npm ci` is the authoritative dependency installation command. Run `npx --no-install install-electron` to install the pinned native Electron runtime explicitly; otherwise the development launcher downloads it on first use. Browser tests also require `npx playwright install chromium` or an explicitly configured `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Runtime setup and packaging tools download their required binaries; the application itself does not use the network for conversion or inspection.

## Validation builds

- `npm run build:linux`: unpacked Linux x64 application under `dist/linux-unpacked`.
- `npm run build:win`: unpacked Windows x64 application under `dist/win-unpacked`.
- `npm run verify:package -- --platform linux --dir dist/linux-unpacked`: verify native entrypoint, identity, packaged application, and launcher policy.

The Windows native binary is `ChatGPT-Export-Processor.exe`. Linux uses `chatgpt-export-processor`, plus `bin/chatgpt-export-processor` pointing directly to it. Development scripts are source tools and are not application launcher wrappers.

Linux requires a graphical desktop, x86-64 glibc 2.34 or newer, and Electron's shared library dependencies. Debian packaging requires GNU `tar` and `dpkg-deb` 1.21.9 or newer on the build host. Windows metadata editing can require platform tooling when cross-building; native Windows builds are preferred. Keep operating-system sandbox support enabled.

## Release packages

Only after release approval:

```sh
npm run pack:linux
npm run pack:win
```

The build script is offline with respect to publishing: `publish` is fixed to `never`. It does not create commits, tags, release records, or upload assets. The initial runtime download and dependency installation require the official dependency sources.

Windows portable ZIPs contain the EXE at archive root. Linux tar archives contain the native executable and a `bin` symlink. Debian installation creates a direct native entrypoint in `usr/bin`; it does not install a shell launcher. The package maintainer is `davoda1`, without an embedded personal contact address.

Every binary package includes the project README, build/platform notes, project license, and required third-party notices alongside the native executable. Linux tar headers use numeric ownership, sorted entries, and a fixed timestamp rather than recording the build account. Debian archive metadata uses root ownership and a fixed timestamp. This normalization is not a claim that binaries from different operating systems or toolchains are byte-for-byte reproducible.

## Installing and launching

On Windows, extract the complete portable ZIP into a new folder and open `ChatGPT-Export-Processor.exe`. Keep the adjacent runtime files with the executable. The initial release is unsigned; Windows may show an unknown-publisher or reputation prompt.

On Debian and Ubuntu, install the `.deb` through the package manager so dependencies and the native `usr/bin` entry are configured. The package lists both current `t64` dependency names and their earlier equivalents. Its supplied `chrome-sandbox` is installed as root-owned mode `4755`, enabling Chromium's fallback sandbox on systems that restrict unprivileged user namespaces. Removal through the package manager removes the application files; user-created exports and appearance preferences remain in their user-owned locations.

For the Linux tar archive, extract the full archive into a new directory and run `chatgpt-export-processor` or its `bin` symlink. This portable form requires the runtime libraries and operating-system sandbox support. On systems such as Ubuntu installations that restrict unprivileged user namespaces, use the Debian package, or have an administrator install the extracted application in an administrator-owned directory and configure its supplied `chrome-sandbox` as root-owned mode `4755`. Do not run the application as root or disable its sandbox as a normal installation workaround.

Release automation tests the native Windows portable archive and Linux tar archive, and installs, runs, and removes the Debian package on Ubuntu 24.04. The portable Linux test prepares the sandbox helper for that runner's restricted namespace policy; the Debian test relies on permissions supplied by the package itself.

## Repeating a package build

Packaging refuses to replace an existing distributable of the same filename. Move old local build outputs aside before repackaging. Do not bump the application version merely to repeat a build.

## Verification boundaries

`npm run test:desktop` exercises the Electron application boundary. After building, `npm run test:packaged` checks the native executable, bundled dependencies, ASAR worker execution, and conversion/inspection together. `npm run test:large` runs the generated large-archive workload. These scripts do not rely on genuine conversation exports.

Core tests must cover conversion preservation, malformed inputs, archive safety, duplicate identifiers, schema drift, incomplete baseline coverage, report escaping, and no-overwrite behavior. UI tests must exercise file selection, cancellation, report review, and keyboard-accessible navigation at the minimum supported window size.

A successful cross-build establishes package structure and metadata only. Native Windows execution, Linux desktop startup, and actual installer behavior need their own checks. Record environment and result summaries without embedding private paths or conversation content.

Retain upstream Electron/Chromium and dependency legal notices in release packages. These notices may identify their original authors; they do not represent the application's maintainer configuration.

## Dependency maintenance

The lockfile pins the runtime and development dependency graph. The `global-agent` override removes an older development-only logging chain with a transitive `sprintf-js` advisory. The override retains the downloader bootstrap API and is covered by actual platform build checks. Reassess it when updating electron-builder.

The build uses the pinned official `@electron/get` downloader and its integrity checks before passing the Electron archive to electron-builder. TLS verification is not disabled. The current source build uses Electron 45.0.0 and electron-builder 26.15.3.
