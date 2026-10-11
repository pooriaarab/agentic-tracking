---
name: agentic-tracking
description: Attribute calls to lines and credit leads.
---

# Agentic tracking

Use attribute_calls with to, from, since, limit, file, lines, source or sources, sink or sinks.
Dry runs default to true. Preview before an authorized live call.
Use list_lines to read Twilio or Telnyx numbers with a line map.
Use list_sources to check key status and get_cost_report for session totals.
The CLI exposes attribute, lines, sources, costs, doctor, mcp, help, and version.
The SDK exports runAttribution and six adapters from agentic-tracking.
Respect guard denials and report failed sources and sinks as errors.
