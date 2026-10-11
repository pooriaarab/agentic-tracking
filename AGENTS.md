# Agentic tracking agent guide

Attribute calls to lines and credit leads.

Use runAttribution in the SDK, attribute in the CLI, or attribute_calls over MCP.
Preview runs first. Set dryRun false only for an authorized live call.
Select sources with source or sources, sinks with sink or sinks.
Call list_sources to check key status. Call list_lines to read Twilio numbers.
Call get_cost_report to read session units. Units count calls, not currency.
Respect guard denials. Report each failed source or sink as a failure.
Run doctor to check vendor reach before a live run.
Credit needs a matched line and a duration above zero.
Never change the frozen core contract.
