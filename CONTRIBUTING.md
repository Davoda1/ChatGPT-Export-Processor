# Contributing

Use a focused change with a clear description of the user-visible problem and expected behavior. Preserve the local-only model, input immutability, explicit validation coverage, and platform packaging rules.

Before proposing a change:

1. Install the locked dependencies with `npm ci`.
2. Run `npm test`, `npm run test:privacy`, and the relevant GUI tests.
3. Exercise both supported workflows and both light and dark themes for UI changes.
4. Use synthetic fixtures. Never commit conversation exports, screenshots containing personal data, credentials, internal paths, or private infrastructure details.
5. Update documentation and regression coverage for changed behavior.

Keep dependency changes explicit and update the lockfile. Do not introduce telemetry, remote processing, background update checks, shell launcher entrypoints, or automatic migration from another application's settings.

A validation engine change must include a fixture that demonstrates the original failure and verifies the intended preservation behavior. Do not loosen expected results solely to make a test pass. Report platform checks honestly: building a Windows binary on Linux does not establish that it ran successfully on Windows.
