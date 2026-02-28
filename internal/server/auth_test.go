package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

// Helper to build valid WebApp initData with correct HMAC signature.
func buildWebAppInitData(token string, authDate int64, userJSON string) string {
	params := url.Values{}
	params.Set("auth_date", fmt.Sprintf("%d", authDate))
	params.Set("user", userJSON)

	keys := []string{"auth_date", "user"}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, k+"="+params.Get(k))
	}
	dataCheckString := strings.Join(parts, "\n")

	secretKey := hmac.New(sha256.New, []byte("WebAppData"))
	secretKey.Write([]byte(token))
	secret := secretKey.Sum(nil)

	h := hmac.New(sha256.New, secret)
	h.Write([]byte(dataCheckString))
	hash := hex.EncodeToString(h.Sum(nil))

	params.Set("hash", hash)
	return params.Encode()
}

// Helper to build valid TelegramLoginData with correct HMAC signature.
func buildLoginData(token string, data TelegramLoginData) TelegramLoginData {
	var parts []string
	parts = append(parts, fmt.Sprintf("auth_date=%d", data.AuthDate))
	if data.FirstName != "" {
		parts = append(parts, "first_name="+data.FirstName)
	}
	parts = append(parts, fmt.Sprintf("id=%d", data.ID))
	if data.LastName != "" {
		parts = append(parts, "last_name="+data.LastName)
	}
	if data.PhotoURL != "" {
		parts = append(parts, "photo_url="+data.PhotoURL)
	}
	if data.Username != "" {
		parts = append(parts, "username="+data.Username)
	}
	sort.Strings(parts)
	dataCheckString := strings.Join(parts, "\n")

	secretHash := sha256.Sum256([]byte(token))
	h := hmac.New(sha256.New, secretHash[:])
	h.Write([]byte(dataCheckString))
	data.Hash = hex.EncodeToString(h.Sum(nil))
	return data
}

func TestValidateWebAppData_ValidSignature(t *testing.T) {
	token := "test-bot-token"
	userJSON := `{"id":123456,"first_name":"Test","last_name":"User","username":"testuser"}`
	initData := buildWebAppInitData(token, time.Now().Unix(), userJSON)

	valid, user, err := ValidateWebAppData(token, initData)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Fatal("expected valid signature")
	}
	if user == nil {
		t.Fatal("expected non-nil user")
	}
	if user.ID != 123456 {
		t.Errorf("expected user ID 123456, got %d", user.ID)
	}
	if user.FirstName != "Test" {
		t.Errorf("expected first name 'Test', got %q", user.FirstName)
	}
	if user.LastName != "User" {
		t.Errorf("expected last name 'User', got %q", user.LastName)
	}
	if user.Username != "testuser" {
		t.Errorf("expected username 'testuser', got %q", user.Username)
	}
}

func TestValidateWebAppData_EmptyInitData(t *testing.T) {
	_, _, err := ValidateWebAppData("test-bot-token", "")
	if err == nil {
		t.Fatal("expected error for empty initData")
	}
}

func TestValidateWebAppData_MissingHash(t *testing.T) {
	params := url.Values{}
	params.Set("auth_date", fmt.Sprintf("%d", time.Now().Unix()))
	params.Set("user", `{"id":123456,"first_name":"Test"}`)
	initData := params.Encode()

	_, _, err := ValidateWebAppData("test-bot-token", initData)
	if err == nil {
		t.Fatal("expected error for missing hash")
	}
}

func TestValidateWebAppData_InvalidHash(t *testing.T) {
	token := "test-bot-token"
	userJSON := `{"id":123456,"first_name":"Test","last_name":"User","username":"testuser"}`
	initData := buildWebAppInitData(token, time.Now().Unix(), userJSON)

	// Tamper with the data by replacing the hash
	parsed, _ := url.ParseQuery(initData)
	parsed.Set("hash", "0000000000000000000000000000000000000000000000000000000000000000")
	tampered := parsed.Encode()

	valid, _, err := ValidateWebAppData(token, tampered)
	if err != nil {
		// Some implementations return error, some return valid=false
		return
	}
	if valid {
		t.Fatal("expected invalid signature for tampered data")
	}
}

func TestValidateWebAppData_ExpiredAuthDate(t *testing.T) {
	token := "test-bot-token"
	userJSON := `{"id":123456,"first_name":"Test","last_name":"User","username":"testuser"}`
	expiredTime := time.Now().Add(-25 * time.Hour).Unix()
	initData := buildWebAppInitData(token, expiredTime, userJSON)

	_, _, err := ValidateWebAppData(token, initData)
	if err == nil {
		t.Fatal("expected error for expired auth_date")
	}
}

func TestValidateTelegramLoginWidget_ValidData(t *testing.T) {
	token := "test-bot-token"
	data := buildLoginData(token, TelegramLoginData{
		ID:        123456,
		FirstName: "Test",
		AuthDate:  time.Now().Unix(),
	})

	valid, user, err := ValidateTelegramLoginWidget(token, data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Fatal("expected valid signature")
	}
	if user == nil {
		t.Fatal("expected non-nil user")
	}
	if user.ID != 123456 {
		t.Errorf("expected user ID 123456, got %d", user.ID)
	}
	if user.FirstName != "Test" {
		t.Errorf("expected first name 'Test', got %q", user.FirstName)
	}
}

func TestValidateTelegramLoginWidget_InvalidHash(t *testing.T) {
	data := TelegramLoginData{
		ID:        123456,
		FirstName: "Test",
		AuthDate:  time.Now().Unix(),
		Hash:      "0000000000000000000000000000000000000000000000000000000000000000",
	}

	valid, _, err := ValidateTelegramLoginWidget("test-bot-token", data)
	if err != nil {
		return
	}
	if valid {
		t.Fatal("expected invalid signature for wrong hash")
	}
}

func TestValidateTelegramLoginWidget_ExpiredAuthDate(t *testing.T) {
	token := "test-bot-token"
	data := buildLoginData(token, TelegramLoginData{
		ID:        123456,
		FirstName: "Test",
		AuthDate:  time.Now().Add(-25 * time.Hour).Unix(),
	})

	_, _, err := ValidateTelegramLoginWidget(token, data)
	if err == nil {
		t.Fatal("expected error for expired auth_date")
	}
}
