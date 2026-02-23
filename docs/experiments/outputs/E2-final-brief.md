# payment reconciliation failure - Investigation Brief

## Timeline

1. **09:00** – "reconciliation v2 enabled 09:00" (early/launch-plan.md)
2. **09:03** – "[09:03] rollout 50" (late/app-08.log)
3. **09:09** – "[09:09] lag 90s" (late/app-08.log)
4. **09:11** – "09:11 reconcile_latency_high" (late/alerts.log)
5. **09:12** – "[09:12] duplicate key" (late/app-08.log)
6. **09:12** – "[09:12] duplicate-key anomaly" (late/shards/shard-00.log)
7. **09:15** – "[09:15] rollout 100" (late/app-09.log)
8. **09:17** – "[09:17] partner_b missing external_txn_id" (late/app-09.log)
9. **09:19** – "[09:19] retry storm" (late/app-09.log)
10. **09:24** – "[09:24] lag 420s" (late/app-08.log)
11. **09:27** – "ledger_drift_critical" (late/alerts.log)

## Impact

- Payment reconciliation failed to complete in a timely and correct manner, as indicated by "reconcile_latency_high" and "ledger_drift_critical" (late/alerts.log).
- Significant lag in processing: "[09:09] lag 90s", "[09:24] lag 420s" (late/app-08.log).
- Duplicate key anomalies observed in multiple shards: "[09:12] duplicate-key anomaly" (late/shards/shard-00.log), "[09:17] duplicate-key anomaly" (late/shards/shard-05.log), "[09:22] duplicate-key anomaly" (late/shards/shard-10.log), "[09:27] duplicate-key anomaly" (late/shards/shard-15.log).
- Partner integration issues: "[09:17] partner_b missing external_txn_id" (late/app-09.log).
- Retry storms and increased load: "[09:19] retry storm" (late/app-09.log).

## Top Factors

1. **Concurrency and duplicate key issues**: Multiple logs show "duplicate-key anomaly" across shards (late/shards/shard-00.log, shard-05.log, shard-10.log, shard-15.log).
2. **Partner data quality**: "partner_b missing external_txn_id" (late/app-09.log).
3. **System lag and retries**: "lag 90s", "lag 420s", "retry storm" (late/app-08.log, late/app-09.log).
4. **Critical drift in ledger**: "ledger_drift_critical" (late/alerts.log).
5. **High reconciliation latency**: "reconcile_latency_high" (late/alerts.log).
6. **Rapid rollout**: "[09:03] rollout 50", "[09:15] rollout 100" (late/app-08.log, late/app-09.log).

## Conflicting Hypotheses

- **Concurrency bug vs. partner data issue**: Duplicate key anomalies could be due to internal race conditions or external data inconsistencies (see both duplicate-key logs and missing external_txn_id).
- **System overload vs. software defect**: Retry storms and lag could be due to insufficient scaling or a bug causing cascading failures.
- **Ledger drift cause**: Whether ledger drift is a symptom of reconciliation logic failure or a separate data consistency issue.

## Recovery Actions

- Alert muting and investigation: "09:18 alert muted" (late/alerts.log).
- Rollout paused/escalated: Rollout logs suggest staged deployment, but no explicit rollback observed.
- Manual inspection of partner data and duplicate key logs.
- Monitoring and escalation of "ledger_drift_critical" and "reconcile_latency_high".

## Unresolved Questions

1. Was the root cause the duplicate key anomaly, partner data, or both?
2. Did the rapid rollout contribute to the system's inability to recover?
3. Was there a fallback or rollback mechanism for reconciliation v2?
4. How many transactions were affected or lost?
5. Was the ledger drift fully resolved, or is there lingering data inconsistency?
6. What specific code or process caused the retry storm?
7. Were all partners affected, or only partner_b?
8. Is there a persistent risk of recurrence under load?

---

### Cited Snippets

1. "reconciliation v2 enabled 09:00" (early/launch-plan.md)
2. "[09:03] rollout 50" (late/app-08.log)
3. "[09:09] lag 90s" (late/app-08.log)
4. "09:11 reconcile_latency_high" (late/alerts.log)
5. "[09:12] duplicate-key anomaly" (late/shards/shard-00.log)
6. "[09:17] partner_b missing external_txn_id" (late/app-09.log)
7. "[09:19] retry storm" (late/app-09.log)
8. "ledger_drift_critical" (late/alerts.log)

Files cited: early/launch-plan.md, late/app-08.log, late/app-09.log, late/alerts.log, late/shards/shard-00.log, late/shards/shard-05.log, late/shards/shard-10.log, late/shards/shard-15.log.
