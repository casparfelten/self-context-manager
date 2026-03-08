# Outage Hypothesis Evidence Table

| Evidence Source              | Mapping Bug Hypothesis                                                                 | Retry Storm Hypothesis                                                               |
|------------------------------|---------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| **Early Design Docs**        | Mentions custom mapping logic for request routing; risk of edge-case bugs noted.      | Retry logic described as exponential backoff; no mention of circuit breaker.         |
| **Mid Analytics**            | Sudden drop in successful checkouts for a specific region; aligns with mapping error. | Spike in request volume and repeated attempts per user session; suggests retry storm.|
| **Late Logs**                | Error logs show requests routed to non-existent shards; mapping failure evidence.      | Logs show repeated identical requests with short intervals; classic retry storm sign.|
| **Retro Notes**              | Team discusses a bug in the mapping table update process as a root cause candidate.   | Notes mention retry amplification worsened the outage duration and load.             |

---

## Hypothesis Brief

**Mapping Bug:**  
- Supported by early design doc warnings, analytics showing regional impact, logs of routing errors, and retro discussion of mapping table bugs.
- Contradicted by evidence of widespread retry behavior, which may be a downstream effect.

**Retry Storm:**  
- Supported by analytics showing high request volume and logs of repeated retries.
- Contradicted by initial cause evidence pointing to mapping errors; retry storm likely an exacerbating factor.
