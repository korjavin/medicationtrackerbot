1. **Add `limiter` to `PushAPI`:**
   - In `internal/cloudserver/push.go`, add `limiter *rateLimiter` to `PushAPI` struct.
   - In `NewPushAPI`, initialize `limiter` with `newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow)`.
   - In `RegisterRoutes` inside `internal/cloudserver/push.go`, wrap the `GET /api/push/vapid-public-key` endpoint handler (`a.GetVapidPublicKey`) with `limitByIP(a.limiter, ...)`.

2. **Add `limiter` to `TransferAPI`:**
   - In `internal/cloudserver/transfer.go`, add `limiter *rateLimiter` to `TransferAPI` struct.
   - In `NewTransferAPI`, initialize `limiter` with `newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow)`.
   - In `RegisterRoutes` inside `internal/cloudserver/transfer.go`, wrap the `POST /api/transfer/{slot_id}/claim` endpoint handler (`a.ClaimTransfer`) with `limitByIP(a.limiter, ...)`.

3. **Add `limiter` to `TelegramAPI`:**
   - In `internal/cloudserver/telegram.go`, add `limiter *rateLimiter` to `TelegramAPI` struct.
   - In `NewTelegramAPI`, initialize `limiter` with `newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow)`.
   - In `RegisterWebhookRoutes` inside `internal/cloudserver/telegram.go`, wrap the `POST /tg/manager/{secret}` and `POST /tg/bot/{ref}/{secret}` endpoint handlers (`t.ManagerWebhook` and `t.ChildWebhook`) with `limitByIP(t.limiter, ...)`.

4. **Verify changes and complete pre commit steps:**
   - Ensure the endpoints still compile and tests pass.
   - Execute tests as needed.
   - Run the pre_commit_instructions to ensure proper testing, verification, review, and reflection are done.

5. **Commit code:**
   - Create PR with appropriate message.
