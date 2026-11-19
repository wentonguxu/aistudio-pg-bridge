# Account usage and proof error handling

Goal: show per-account and per-model observed usage without inventing remaining quota.

1. Add regression tests for persistent daily outcomes, rollover, unknown quota, and transient proof failures.
2. Extend the existing account store and cookie persistence with daily outcomes and per-model status. Keep existing successful-request counters and imported credentials.
3. Classify proof errors separately, retry transient signer failures once, and record each upstream attempt including failover. Record completed responses separately from transport failures.
4. Extend the existing dashboard with expandable usage details, latest failure, observation time, and explicit unknown remaining quota. Do not add another HTML page or issue automatic model probes.
5. Run focused tests and the existing stream suite, inspect the diff for secrets, commit only changed files, push to the personal fork, then restart and verify authenticated status and public health.

Files: src/dashboard.js, src/relay-server.js, src/cookie-store.js, test/account-usage.test.js (under 2-relay-client-gateway).
Storage: extend the existing backend account records; no new browser credential store. Old records load with zero new counters and retain their historical accepted-request count. Daily rollover is the existing local 15:00 bucket, not a promise about Google's quota reset.

## Model-aware pool stability

Prefer accounts whose latest observation for the requested base model was successful in the last 30 minutes. Keep round-robin selection among equally eligible accounts. Normalize wrapper prefixes and thinking suffixes to one usage key. On failure, exclude that account for that model for 30 seconds; retain the account and its availability for other models. Persist cooldowns in the existing modelUsage record and show temporary cooling in the dashboard.

When every ready account is cooling for the requested model, return a clear 503 without calling Google. Retry temporary signing failures on another eligible account, at most three distinct accounts. Do not start another account failover after 30 seconds from the initial attempt; this is not a total timeout on model generation. Preserve the requested model suffix and thinking configuration during every retry. Do not replay a stream after partial output.

Verify preference, cooldown persistence/expiry, cross-model isolation, wrapped model normalization, all-cooling 503, signer failover, low-thinking preservation, the existing streaming suite, and the native proxy test. Phone rollout requires pulling the updated fork and restarting Termux; credentials are not modified.

## Latency follow-up

The existing model list already supports `gemini-4-argon-low`; retain it and retain the default high-thinking behavior. Native environment proxy mode is already enabled in the local launcher. Prefer the native pooled fetch transport when its explicit CLI flag and matching proxy environment variable are present; keep the legacy proxy implementation for other runtimes. Verify with a local HTTP/CONNECT proxy that sequential requests reuse one connection, and check public health after restart. This removes connection setup overhead, not model thinking time or third-party signer outages.
