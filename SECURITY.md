# Security

Supported development line: **1.0.x**. No hosted service, account credentials, or automatic updater is part of this application.

Treat ChatGPT exports as private and untrusted input. The desktop renderer does not execute imported HTML. File access is mediated by the main process; conversion and inspection run outside the renderer. Archive entries, decompressed sizes, record sizes, and output destinations are validated. These controls reduce risk but do not make arbitrary files safe to open in other programs.

Reports and converted output can contain conversation content. Review them before sharing. Never attach a real export, secret, personal filesystem path, or access token to a public issue.

Report a suspected vulnerability privately through the repository's security reporting feature when it is available. If private reporting has not been configured, request a private reporting channel without publishing exploit details or confidential data. Security reporting configuration is part of repository setup; this document does not imply that it is already enabled.

The reproducible source build uses locked npm dependencies. Published binaries should be accompanied by one consolidated `SHA256SUM.txt`; checksum comparison checks file integrity, not code provenance or a security audit. Windows code signing and operating-system trust prompts depend on the release signing setup.
