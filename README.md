# ChatGPT Export Processor

**Version 1.0.0** · Windows and Linux · MIT · Maintained by **davoda1**

Convert ChatGPT export archives into readable JSON and an offline HTML viewer, then inspect what changed. The application combines export conversion with independent preservation checks, findings, and schema inspection in a local desktop workbench.

The input format is a ChatGPT export. Other chat providers and arbitrary HTML documents are not supported. This is an independent project and is not affiliated with OpenAI.

## What it does

- Converts supported ChatGPT rich content, citations, and writing blocks while preserving user messages and conversation structure.
- Produces `conversations-index.json`, `chat-index.html`, a processed bundle, and validation reports in a new output folder.
- Inspects existing converted JSON, HTML, or a processed bundle against the original export when available.
- Compares conversion rules, user content, graph structure, IDs, JSON/HTML agreement, and known schema signatures.
- Shows findings with original, expected, and actual evidence rather than treating every warning as a failed conversion.
- Uses system, light, or blue-black dark appearance, with a responsive workbench designed for a minimum 680 × 540 window.

Processing is local. No account, credentials, remote service, upload destination, or personal infrastructure configuration is needed. Application updates are manual.

## Download and install

Download **v1.0.0** from [GitHub Releases](https://github.com/davoda1/ChatGPT-Export-Processor/releases/tag/v1.0.0). Windows and Linux packages target x64/amd64 systems.

| Package | Installation |
| --- | --- |
| Windows portable ZIP | Extract the complete ZIP into a folder and run `ChatGPT-Export-Processor.exe` at its root. Keep the accompanying files together. |
| Debian/Ubuntu `.deb` | Install with `sudo apt install ./chatgpt-export-processor_1.0.0_amd64.deb`, then open the application from the desktop menu. |
| Linux portable `.tar.gz` | Extract into an empty folder and run `bin/chatgpt-export-processor`. The entrypoint is a symlink to the native executable. |
| Source ZIP or `.tar.gz` | Follow the source build instructions below. Dependencies are installed separately. |

Use the release's single `SHA256SUM.txt` to verify downloads. On Linux, run `sha256sum --ignore-missing -c SHA256SUM.txt` in the download folder. On Windows, compare the SHA-256 reported by PowerShell's `Get-FileHash` with the corresponding entry.

The Windows executable is unsigned and may show an unknown-publisher prompt. Linux portable execution requires working Chromium sandbox support; use the Debian package on supported Debian/Ubuntu systems that restrict unprivileged user namespaces. See [platform and sandbox details](docs/BUILDING.md).

## Convert an export

1. Select **Convert & validate** in the workspace.
2. Choose the original ChatGPT export ZIP and a destination folder.
3. Select the optional standard, document, and chat-message writing-block transformations. Email conversion stays enabled.
4. Start the conversion. The application writes into a fresh output subfolder and leaves input files unchanged.
5. Review the overview, findings, and schema checks before relying on the result.

Cancellation removes the current unfinished output owned by that run. Existing exports and earlier completed output folders are not replacement targets.

## Inspect an existing conversion

Choose **Inspect existing**, select the original export when available, and supply converted JSON, converted HTML, or a processed bundle. A bundle can contain both converted formats. An inspection without an original baseline has limited preservation coverage.

Use automatic profile detection for unknown conversion options. An explicit **All writing blocks** or **Email only** profile makes the intended conversion rules unambiguous. Inspection never runs scripts from supplied HTML and does not repair or rewrite the selected files.

## Understand a result

| Result | Meaning |
| --- | --- |
| Passed | The applicable checks completed without a detected mismatch and the required baseline was available. |
| Review needed | The inspection completed but found warnings, ambiguity, or unfamiliar structure needing review. |
| Failed | A preservation, integrity, or conversion-rule check detected an error. |
| Limited coverage | Missing inputs or an inspection limit prevented a complete preservation assessment. |

A passing result is evidence about the implemented checks, not a guarantee that every future ChatGPT format is understood. Schema drift, unsupported rich elements, and ambiguous conversion profiles remain visible. A report never proves that remote links or missing attachments are available.

## Input limits and coverage

The archive reader accepts at most 100,000 ZIP entries, with a 4 GiB limit per selected data entry and a 16 GiB total for selected data entries. Conversation records are limited to 128 MiB and 256 nesting levels. Unsupported numeric values, malformed UTF-8, duplicate keys, unsafe archive paths, encrypted selected entries, and ambiguous file selections require attention rather than silent normalization.

The default finding list retains up to 10,000 entries while counts continue to reflect detected issues. Each evidence pane is capped at 1 MiB and marks truncation. These bounds prevent a report from implying that unavailable evidence was inspected. Record data is streamed, but indexes, findings, and the standalone HTML viewer still require memory proportional to the export's complexity.

## Reports and privacy

Reports can be exported as JSON, HTML, and CSV. Reports omit absolute filesystem paths and raw evidence panes, but include input basenames, conversation titles, identifiers, rule details, counts, and hashes. They are private local reports, not anonymous exports: inspect them before sharing.

The desktop stores only appearance preferences in its separate `ChatGPT-Export-Processor-Public` settings directory. It does not reuse the settings of the earlier personal converter or Traceglass. Keep the originals and any sensitive output in a location you control.

## Run from source

Install Node.js 24 and npm 11. Runtime and tool dependencies are pinned in `package-lock.json`.

```sh
npm ci
npx playwright install chromium
npm test
npm run test:privacy
npm start
```

Browser tests require a Chromium installation. `npx playwright install chromium` installs the pinned Playwright browser; alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible existing Chromium executable. The GUI requires a desktop display. On a Linux CI host, run GUI tests under an X server such as Xvfb. Do not disable the Chromium sandbox in a normal installation. A privileged container may need a test-only launch option; that is not part of the packaged application configuration.

### Command line

The command-line interface uses the same processing and validation engines as the GUI:

```sh
node src/cli.cjs --help
mkdir output
node src/cli.cjs convert export.zip --output-dir output
node src/cli.cjs inspect --original export.zip --json conversations-index.json --html chat-index.html
node src/cli.cjs inspect --bundle chatgpt-export-processed.zip --report report.json --format json
```

Packaged applications accept `--cli` followed by the same command. Linux example:

```sh
chatgpt-export-processor --cli convert export.zip --output-dir output
```

Conversion accepts `--no-standard`, `--no-document`, and `--no-chat-message`. Inspection accepts `--profile auto`, `all`, or `email`.

On a Linux host without a desktop display, run the source CLI with Node, or place `--ozone-platform=headless --disable-gpu` before `--cli` when using the native binary. These flags select the headless display backend; leave the normal sandbox enabled.

| Exit code | Meaning |
| --- | --- |
| 0 | Passed |
| 1 | Input, configuration, or processing error |
| 2 | Review needed |
| 3 | Failed validation |
| 4 | Limited coverage |
| 130 | Cancelled |

## Development and packaging

```sh
npm test
npm run test:privacy
npm run test:ui
npm run test:desktop
npm run test:large
npm run build:linux
npm run build:win
```

`build:*` creates unpacked validation builds in `dist`. It never publishes anything. Build Windows packages on Windows for the authoritative platform test; a cross-build on Linux is not a substitute for a native Windows run.

When preparing an approved release, `npm run pack:linux` creates a native Linux tar archive and Debian package; `npm run pack:win` creates a portable ZIP with the native EXE at its root. Linux packages expose a native executable or a symlink to it. There are no launcher wrappers. Release packaging does not upload files or create GitHub releases.

See [BUILDING.md](docs/BUILDING.md), [CI.md](docs/CI.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [third-party notices](docs/THIRD-PARTY-NOTICES.md).

## Project status

This is the first public edition at version 1.0.0. GitHub Actions validates the source and native Windows and Linux builds. Release packaging and publication are separate from continuous integration.
