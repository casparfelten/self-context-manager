Architecture Review
- Reconciliation reads ledger_events and gateway_events
- join key: external_txn_id
- known caveat: partner B omits external_txn_id for partial refunds
