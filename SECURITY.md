# Security policy

## Supported version

Security fixes are provided for the latest published codex-sdlc version.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for `prime-vimihi/codex-sdlc`. Do not open a public issue with exploit details or sensitive repository content. Include the affected version, reproduction steps, impact, and any suggested mitigation.

## Local data boundary

codex-sdlc runs inside the selected repository. It writes framework state and command evidence under `.sdlc/`. Evidence can contain command output, paths, and source-derived diagnostics. Redaction applies only to secret environment variables explicitly named in the installed policy. Review evidence before sharing or committing it.

The package has no install or postinstall script and does not require a codex-sdlc account or remote service.
