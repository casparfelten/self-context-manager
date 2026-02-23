# Outage Hypotheses Evidence Table

| Evidence Source         | Mapping Bug Hypothesis                                    | Retry Storm Hypothesis                        |
|------------------------|----------------------------------------------------------|-----------------------------------------------|
| Early Design Docs      | [TKT-4431] Partner B mapping issue deferred before launch | [Risk Register] "retry storm" listed as risk  |
| Mid Analytics          | No mapping-related failures in analytics                  | No retry-related failures in analytics        |
| Late Logs              | No direct mapping bug logs                               | [app-09.log] "[09:19] retry storm" observed  |
| Retro Notes            | Mapping bug discussed as possible, but not confirmed      | Retry storm confirmed as root cause           |

## Summary
- Mapping bug was a known risk (deferred ticket), but not supported by analytics or logs.
- Retry storm was a known risk, observed in logs, and confirmed in retro notes as the root cause.

## Sources
- tickets/TKT-4431.md
- early/risk-register.md
- mid/analytics-checkout.csv
- mid/analytics-recon.csv
- late/app-09.log
- retro/retro-draft.md
