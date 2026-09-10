# Web target rules

Target exactly `web`; stage exactly `web_implementation`. Keep every path under web-owned assignment roots.

Capabilities are PM-assigned, canonical lower-case identifiers such as `loading`, `safe_fallback`, `output_escaping`, or `keyboard_operation`. They must match `^[a-z][a-z0-9_]*$` and be unique within the assignment. Preserve each requirement ID, capability, required flag, controlled parameters, and source references exactly.

Do not emit mobile paths or mobile capabilities.
