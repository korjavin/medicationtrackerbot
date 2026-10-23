-- +goose Up
-- +goose StatementBegin
-- Device-transfer protocol v2 (med-r1j2.1, docs/cloud-crypto.md "Path B"):
-- approve-on-origin with receiver-bound key release. The slot is a state
-- machine pending -> claimed -> revealed -> approved -> enrolled. Every new
-- column is a public protocol value the server relays but cannot use: commit /
-- o_pub / n_pub are ephemeral ECDH public material, mac_n / mac_o are keyed by
-- the transfer key the server never sees, conf_n is keyed by the ECDH-derived
-- key. ct stays NOT NULL and holds an empty blob until approve (recovery slots
-- already store one), so no table rebuild is needed.
ALTER TABLE transfer_slots ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE transfer_slots ADD COLUMN commit_hash BLOB;
ALTER TABLE transfer_slots ADD COLUMN n_pub BLOB;
ALTER TABLE transfer_slots ADD COLUMN mac_n BLOB;
ALTER TABLE transfer_slots ADD COLUMN platform TEXT;
ALTER TABLE transfer_slots ADD COLUMN o_pub BLOB;
ALTER TABLE transfer_slots ADD COLUMN mac_o BLOB;
ALTER TABLE transfer_slots ADD COLUMN conf_n BLOB;
ALTER TABLE transfer_slots ADD COLUMN approving_credential_id BLOB;
-- In-flight rows at deploy time (10-minute TTL): a v1 slot that was already
-- fetched, and every recovery slot (inserted fetched=1), already handed its
-- enrollment token out — map them to 'approved' so those ceremonies can still
-- finish. Unfetched v1 slots stay 'pending' with no commit, which no v2 claim
-- can complete; they expire within ten minutes.
UPDATE transfer_slots SET state = 'approved' WHERE fetched = 1;
CREATE INDEX idx_transfer_slots_approving_credential ON transfer_slots(approving_credential_id);

-- Coarse platform label of the device a credential was enrolled from through
-- a v2 transfer (web | android | ios). NULL for every credential enrolled any
-- other way (signup, recovery, session add, all pre-v2 rows): the devices list
-- renders those exactly as before.
ALTER TABLE credentials ADD COLUMN platform TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE credentials DROP COLUMN platform;
DROP INDEX idx_transfer_slots_approving_credential;
ALTER TABLE transfer_slots DROP COLUMN approving_credential_id;
ALTER TABLE transfer_slots DROP COLUMN conf_n;
ALTER TABLE transfer_slots DROP COLUMN mac_o;
ALTER TABLE transfer_slots DROP COLUMN o_pub;
ALTER TABLE transfer_slots DROP COLUMN platform;
ALTER TABLE transfer_slots DROP COLUMN mac_n;
ALTER TABLE transfer_slots DROP COLUMN n_pub;
ALTER TABLE transfer_slots DROP COLUMN commit_hash;
ALTER TABLE transfer_slots DROP COLUMN state;
-- +goose StatementEnd
