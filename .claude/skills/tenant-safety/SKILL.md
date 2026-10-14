---
name: tenant-safety
description: Review Mujeeb features that persist, retrieve, authorize, or execute data/actions for multiple clinics or hospitals. Use when adding tenancy, knowledge, tools, database access, hospital integrations, admin features, or analytics.
---

# Tenant and Healthcare Data Safety

When the task touches persistent tenant data or tenant-specific actions:

1. Make `tenant_id` explicit in the trusted application context; never infer it only from model text.
2. Bind database queries and tool execution to the authorized tenant context.
3. Do not let prompt instructions be the sole isolation mechanism.
4. Keep tenant credentials/secrets separated and referenced securely.
5. Validate tool authorization before every sensitive action.
6. Generate auditable events for important side effects.
7. Minimize patient data stored or logged.
8. Define retention/access expectations before storing call recordings or transcripts.
9. Test cross-tenant negative cases: tenant A must never retrieve or execute against tenant B data.
10. Do not invent legal/compliance guarantees; flag unresolved residency, retention, access, and regulatory requirements for review.
