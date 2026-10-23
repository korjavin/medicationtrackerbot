-- +goose Up
-- +goose StatementBegin
-- bd med-ta2n.14: invite requests awaiting the admin's Approve/Decline in the
-- manager bot's admin chat. Two channels: 'email' (the in-app sheet, POST
-- /api/invite-requests: email_lc + note) and 'tg' (a "yes" to the manager
-- bot: tg_chat_id + tg_user_id). No IP is stored. status is the dedupe and
-- the replay guard: a decision is a conditional UPDATE ... WHERE status =
-- 'pending'; 'approved' means the mint + delivery is in flight (re-runnable by
-- the admin once stale), 'done' that it finished. No invite token is ever
-- stored here. Every row is deleted 90 days after created_at_unix (swept on
-- insert).
CREATE TABLE invite_requests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    channel          TEXT    NOT NULL CHECK (channel IN ('email', 'tg')),
    email_lc         TEXT,
    note             TEXT,
    tg_chat_id       INTEGER,
    tg_user_id       INTEGER,
    created_at_unix  INTEGER NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'done')),
    decided_at_unix  INTEGER,
    admin_message_id INTEGER NOT NULL DEFAULT 0
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_invite_requests_email ON invite_requests(email_lc, created_at_unix);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_invite_requests_tg_user ON invite_requests(tg_user_id, created_at_unix);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_invite_requests_created ON invite_requests(created_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE invite_requests;
-- +goose StatementEnd
