package notification

import (
	"context"
	"fmt"
	"log"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// Service coordinates sending notifications across multiple providers
type Service struct {
	store     *store.Store
	providers map[string]Provider
}

// NewService creates a new notification service
func NewService(store *store.Store) *Service {
	return &Service{
		store:     store,
		providers: make(map[string]Provider),
	}
}

// RegisterProvider adds a notification provider
func (s *Service) RegisterProvider(p Provider) {
	if p == nil {
		return
	}
	s.providers[p.Name()] = p
	log.Printf("[NotificationService] Registered provider: %s (actions: %v, max: %d)",
		p.Name(), p.SupportsActions(), p.MaxActions())
}

// Send sends a notification to all enabled providers for the user
func (s *Service) Send(ctx context.Context, userID int64, notif NotificationContext) error {
	// Get enabled providers for this notification type
	enabledProviders, err := s.store.GetEnabledProviders(userID, string(notif.Type))
	if err != nil {
		return err
	}

	if len(enabledProviders) == 0 {
		log.Printf("[NotificationService] No enabled providers for user %d, type %s", userID, notif.Type)
		return nil
	}

	var lastErr error
	sent := 0

	for _, providerName := range enabledProviders {
		provider, ok := s.providers[providerName]
		if !ok {
			log.Printf("[NotificationService] Provider %s not registered, skipping", providerName)
			continue
		}

		if !provider.IsEnabled() {
			log.Printf("[NotificationService] Provider %s not enabled, skipping", providerName)
			continue
		}

		// Adjust actions based on provider capabilities
		adjustedNotif := notif
		if provider.SupportsActions() && len(notif.Actions) > 0 {
			maxActions := provider.MaxActions()
			if len(notif.Actions) > maxActions {
				adjustedNotif.Actions = notif.Actions[:maxActions]
				log.Printf("[NotificationService] Truncated actions from %d to %d for provider %s",
					len(notif.Actions), maxActions, providerName)
			}
		} else if !provider.SupportsActions() {
			adjustedNotif.Actions = nil
		}

		if err := provider.Send(ctx, userID, adjustedNotif); err != nil {
			log.Printf("[NotificationService] Provider %s failed to send: %v", providerName, err)
			lastErr = err
		} else {
			sent++
			log.Printf("[NotificationService] Successfully sent via %s", providerName)
		}
	}

	if sent == 0 && lastErr != nil {
		return lastErr
	}

	return nil
}

// GetProviders returns list of all registered providers with their status
func (s *Service) GetProviders() []ProviderInfo {
	var providers []ProviderInfo
	for name, p := range s.providers {
		providers = append(providers, ProviderInfo{
			Name:            name,
			Enabled:         p.IsEnabled(),
			SupportsActions: p.SupportsActions(),
			MaxActions:      p.MaxActions(),
		})
	}
	return providers
}

// SendSimpleMessage sends a simple text message without actions to enabled providers
func (s *Service) SendSimpleMessage(ctx context.Context, userID int64, message string, notifType NotificationType) error {
	// Get enabled providers for this notification type
	enabledProviders, err := s.store.GetEnabledProviders(userID, string(notifType))
	if err != nil {
		return err
	}

	if len(enabledProviders) == 0 {
		log.Printf("[NotificationService] No enabled providers for simple message")
		return nil
	}

	var lastErr error
	for _, providerName := range enabledProviders {
		provider, ok := s.providers[providerName]
		if !ok || !provider.IsEnabled() {
			continue
		}

		if err := provider.SendSimpleMessage(ctx, userID, message); err != nil {
			log.Printf("[NotificationService] Provider %s failed to send simple message: %v", providerName, err)
			lastErr = err
		}
	}

	return lastErr
}

// RemoveNotification attempts to remove a notification from providers that support it
func (s *Service) RemoveNotification(ctx context.Context, providerName string, notificationID interface{}) error {
	provider, ok := s.providers[providerName]
	if !ok {
		return fmt.Errorf("provider %s not found", providerName)
	}

	if !provider.SupportsNotificationRemoval() {
		return nil // Not an error, just not supported
	}

	return provider.RemoveNotification(ctx, notificationID)
}

type ProviderInfo struct {
	Name            string `json:"name"`
	Enabled         bool   `json:"enabled"`
	SupportsActions bool   `json:"supports_actions"`
	MaxActions      int    `json:"max_actions"`
}
