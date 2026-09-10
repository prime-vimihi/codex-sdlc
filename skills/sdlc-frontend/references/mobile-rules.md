# Mobile target rules

Target exactly `mobile`; stage exactly `mobile_implementation`. Keep every path under mobile-owned assignment roots.

Capabilities are PM-assigned, canonical lower-case identifiers such as `loading`, `offline_failure`, `background_foreground_lifecycle`, or `text_scaling`. They must match `^[a-z][a-z0-9_]*$` and be unique within the assignment. Preserve each requirement ID, capability, required flag, controlled parameters, and source references exactly.

Do not emit web paths or web capabilities.
