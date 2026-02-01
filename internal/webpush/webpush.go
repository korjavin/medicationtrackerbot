package webpush

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type Service struct {
	store           *store.Store
	vapidPublicKey  string
	vapidPrivateKey string
	vapidSubject    string
}

func New(store *store.Store, publicKey, privateKey, subject string) *Service {
	return &Service{
		store:           store,
		vapidPublicKey:  publicKey,
		vapidPrivateKey: privateKey,
		vapidSubject:    subject,
	}
}

// NotificationPayload matches the structure expected by the SW
type NotificationPayload struct {
	Title   string                 `json:"title"`
	Body    string                 `json:"body"`
	Icon    string                 `json:"icon,omitempty"`
	Badge   string                 `json:"badge,omitempty"`
	Tag     string                 `json:"tag,omitempty"`
	Data    map[string]interface{} `json:"data,omitempty"`
	Actions []NotificationAction   `json:"actions,omitempty"`
}

type NotificationAction struct {
	Action string `json:"action"`
	Title  string `json:"title"`
}

func (s *Service) SendMedicationNotification(ctx context.Context, userID int64, meds []store.Medication, scheduledTime time.Time) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil // Web push disabled
	}

	medNames := make([]string, len(meds))
	medIDs := make([]int64, len(meds))
	for i, m := range meds {
		name := m.Name
		if m.Dosage != "" {
			name += " " + m.Dosage
		}
		medNames[i] = name
		medIDs[i] = m.ID
	}

	title := "Time to take medication"
	body := strings.Join(medNames, ", ")

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/android-chrome-192x192.png",
		Badge: "/static/android-chrome-192x192.png", // Monochrome badge preferred, but using icon for now
		Tag:   fmt.Sprintf("medication-%s", scheduledTime.Format(time.RFC3339)),
		Data: map[string]interface{}{
			"type":             "medication",
			"scheduled_at":     scheduledTime.Format(time.RFC3339),
			"medication_ids":   medIDs,
			"medication_names": medNames,
		},
		Actions: []NotificationAction{
			{Action: "confirm_all", Title: "Confirm All"},
			{Action: "snooze", Title: "Snooze 10m"},
		},
	}

	return s.sendToUser(userID, payload)
}

func (s *Service) SendLowStockNotification(ctx context.Context, userID int64, meds []store.Medication) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil
	}

	medNames := make([]string, len(meds))
	for i, m := range meds {
		medNames[i] = m.Name
	}

	title := "Low Stock Warning"
	body := fmt.Sprintf("Running low on: %s", strings.Join(medNames, ", "))

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/android-chrome-192x192.png",
		Tag:   "low-stock",
		Data: map[string]interface{}{
			"type": "low_stock",
		},
	}

	return s.sendToUser(userID, payload)
}

func (s *Service) SendWorkoutNotification(ctx context.Context, userID int64, session *store.WorkoutSession, group *store.WorkoutGroup, variant *store.WorkoutVariant) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil
	}

	title := "Time to Workout!"
	body := fmt.Sprintf("%s - %s", group.Name, variant.Name)

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/android-chrome-192x192.png",
		Tag:   fmt.Sprintf("workout-%d", session.ID),
		Data: map[string]interface{}{
			"type":       "workout",
			"session_id": session.ID,
			"group_name": group.Name,
			"variant":    variant.Name,
		},
		Actions: []NotificationAction{
			{Action: "start", Title: "Start"},
			{Action: "snooze_1h", Title: "Snooze 1h"},
			{Action: "skip", Title: "Skip"},
		},
	}

	return s.sendToUser(userID, payload)
}

func (s *Service) sendToUser(userID int64, payload NotificationPayload) error {
	subs, err := s.store.GetPushSubscriptions(userID)
	if err != nil {
		return err
	}

	if len(subs) == 0 {
		return nil
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	// Send to all user subscriptions
	for _, sub := range subs {
		go func(subscription store.PushSubscription) {
			s.sendToSubscription(subscription, payloadBytes)
		}(sub)
	}

	return nil
}

func (s *Service) sendToSubscription(sub store.PushSubscription, payload []byte) {
	wpSub := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			Auth:   sub.Auth,
			P256dh: sub.P256dh,
		},
	}

	resp, err := webpush.SendNotification(payload, wpSub, &webpush.Options{
		Subscriber:      s.vapidSubject,
		VAPIDPublicKey:  s.vapidPublicKey,
		VAPIDPrivateKey: s.vapidPrivateKey,
		TTL:             3600 * 12, // 12 hours
	})
	if err != nil {
		log.Printf("WebPush error for %s: %v", sub.Endpoint, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusGone {
		// Subscription is no longer valid
		log.Printf("WebPush subscription gone: %s", sub.Endpoint)
		if err := s.store.DisablePushSubscription(sub.Endpoint); err != nil {
			log.Printf("Failed to disable subscription: %v", err)
		}
	} else if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		log.Printf("WebPush unexpected status %d for %s", resp.StatusCode, sub.Endpoint)
	}
}
