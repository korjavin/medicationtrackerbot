package server

import (
	"encoding/json"
	"log"
	"net/http"

)

// handleGetNotificationSettings returns user's notification preferences
func (s *Server) handleGetNotificationSettings(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Get all notification types
	notifTypes := []string{"medication", "workout", "low_stock", "reminder"}
	providers := []string{"telegram", "webpush"}

	type SettingResponse struct {
		Provider string `json:"provider"`
		Type     string `json:"type"`
		Enabled  bool   `json:"enabled"`
	}

	var settings []SettingResponse
	for _, provider := range providers {
		for _, notifType := range notifTypes {
			setting, err := s.store.GetNotificationSetting(userID, provider, notifType)
			enabled := true // Default enabled

			if err == nil && setting != nil {
				enabled = setting.Enabled
			}

			settings = append(settings, SettingResponse{
				Provider: provider,
				Type:     notifType,
				Enabled:  enabled,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"settings": settings,
	})
}

// handleUpdateNotificationSettings updates user's notification preferences
func (s *Server) handleUpdateNotificationSettings(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Provider string `json:"provider"`
		Type     string `json:"type"`
		Enabled  bool   `json:"enabled"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate provider and type
	validProviders := map[string]bool{"telegram": true, "webpush": true}
	validTypes := map[string]bool{"medication": true, "workout": true, "low_stock": true, "reminder": true}

	if !validProviders[req.Provider] {
		http.Error(w, "Invalid provider", http.StatusBadRequest)
		return
	}

	if !validTypes[req.Type] {
		http.Error(w, "Invalid notification type", http.StatusBadRequest)
		return
	}

	// Update setting
	if err := s.store.SetNotificationEnabled(userID, req.Provider, req.Type, req.Enabled); err != nil {
		log.Printf("[Server] Error updating notification setting: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "success",
	})
}

// handleListNotificationProviders returns available notification providers and their capabilities
func (s *Server) handleListNotificationProviders(w http.ResponseWriter, r *http.Request) {
	type ProviderInfo struct {
		Name                     string   `json:"name"`
		DisplayName              string   `json:"display_name"`
		Enabled                  bool     `json:"enabled"`
		SupportsActions          bool     `json:"supports_actions"`
		SupportsRemoval          bool     `json:"supports_removal"`
		SupportedNotificationTypes []string `json:"supported_types"`
	}

	providers := []ProviderInfo{
		{
			Name:                       "telegram",
			DisplayName:                "Telegram",
			Enabled:                    s.bot != nil,
			SupportsActions:            true,
			SupportsRemoval:            true,
			SupportedNotificationTypes: []string{"medication", "workout", "low_stock", "reminder"},
		},
		{
			Name:                       "webpush",
			DisplayName:                "Web Push",
			Enabled:                    s.webPush != nil,
			SupportsActions:            true,
			SupportsRemoval:            false,
			SupportedNotificationTypes: []string{"medication", "workout", "low_stock", "reminder"},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"providers": providers,
	})
}
