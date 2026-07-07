package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/server/vaultformat"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/medication"
)

func TestVaultImport(t *testing.T) {
	s, _ := store.New(":memory:")
	srv := newServer(s, "token", "secret", 1, OIDCConfig{}, "bot", "vapid")

	payload := importRequest{
		Mode: "replace",
		Data: &vaultformat.VaultFile{
			Format:     "medtracker-vault",
			Version:    1,
			ExportedAt: time.Now(),
			Data: &vaultformat.VaultData{
				Medications: &vaultformat.VaultMedications{
					Medications: []medication.Medication{
						{ID: 999, Name: "Test Med"},
					},
					Intakes: []medication.IntakeLog{
						{ID: 888, MedicationID: 999, ScheduledAt: time.Now(), Status: "PENDING"},
					},
				},
			},
		},
	}

	b, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/import", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()

	ctx := req.Context()
	ctx = context.WithValue(ctx, UserCtxKey, &TelegramUser{ID: 1})
	req = req.WithContext(ctx)

	srv.handleImportVault(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestVaultImportFromJSON(t *testing.T) {
	s, _ := store.New(":memory:")
	srv := newServer(s, "token", "secret", 1, OIDCConfig{}, "bot", "vapid")

	// Read from tests/fixtures/vault-v1.json
	importStr := `{
		"mode": "replace",
		"data": {
			"format": "medtracker-vault",
			"version": 1,
			"exported_at": "2026-07-07T12:00:00Z",
			"data": {
				"medications": {
					"medications": [
						{
							"id": 1,
							"name": "Aspirin",
							"dosage": "100mg",
							"schedule": "08:00",
							"tz_shift_policy": "flexible"
						}
					]
				}
			}
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/api/import", bytes.NewReader([]byte(importStr)))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()

	ctx := req.Context()
	ctx = context.WithValue(ctx, UserCtxKey, &TelegramUser{ID: 1})
	req = req.WithContext(ctx)

	srv.handleImportVault(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}
