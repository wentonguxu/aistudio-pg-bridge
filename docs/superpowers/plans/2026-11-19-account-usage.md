# Account usage and proof error handling

Goal: show per-account and per-model observed usage without inventing remaining quota.

1. Add regression tests for persistent daily outcomes, rollover, unknown quota, and transient proof failures.
2. Extend the existing account store and cookie persistence with daily outcomes and per-model status. Keep existing successful-request counters and imported credentials.
3. Classify proof errors separately, retry transient signer failures once, and record each upstream attempt including failover. Record completed responses separately from transport failures.
4. Extend the existing dashboard with expandable usage details, latest failure, observation time, and explicit unknown remaining quota. Do not add another HTML page or issue automatic model probes.
5. Run focused tests and the existing stream suite, inspect the diff for secrets, commit only changed files, push to the personal fork, then restart and verify authenticated status and public health.

Files: src/dashboard.js, src/relay-server.js, src/cookie-store.js, test/account-usage.test.js (under 2-relay-client-gateway).
Storage: extend the existing backend account records; no new browser credential store. Old records load with zero new counters and retain their historical accepted-request count. Daily rollover is the existing local 15:00 bucket, not a promise about Google's quota reset.
