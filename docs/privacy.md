# Privacy policy

Effective date: 2026-09-10

codex-sdlc is a locally executed command-line package and Codex skill bundle. It has no hosted codex-sdlc service, telemetry endpoint, advertising system, or user account system.

The software reads repository configuration and files needed for the requested workflow. In a multi-repository workspace, this includes the Git checkout roots listed in the device-local `.sdlc/local.yaml`; those absolute paths are ignored by Git. It writes installed framework files, delivery artifacts, approvals, defects, and command evidence under `.sdlc/` in the coordinator repository. Configured delivery commands and authorized product changes may operate in the mapped application repositories. Captured command output can contain file paths, diagnostics, or other repository-derived information. Redaction removes values only for secret environment-variable names configured in the installed policy.

codex-sdlc does not independently transmit this local data to the publisher. npm and GitHub process ordinary package download and source-hosting data under their own policies. Codex processes prompts and repository context according to the terms and controls of the Codex service used by the operator.

Operators control retention by retaining, sharing, archiving, or deleting the local `.sdlc/` directory and repository history. The uninstall command preserves project configuration, run history, evidence, and backups so that removal is reversible; operators may delete those retained files through their normal repository process after making any required backup.

Privacy questions can be opened through the repository support channel without including confidential repository content.
