package webpush

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ErrNoSubscriptions is returned by SendNotification when the user has no
// active push subscriptions. Callers that treat delivery to zero recipients
// as a hard failure (e.g. the TZ plan notifier) can check for this error.
var ErrNoSubscriptions = errors.New("webpush: no active push subscriptions")

type Service struct {
	store           *store.Store
	vapidPublicKey  string
	vapidPrivateKey string
	vapidSubject    string
	adminEmail      string
	domain          string
}

func New(store *store.Store, publicKey, privateKey, subject, adminEmail, domain string) *Service {
	return &Service{
		store:           store,
		vapidPublicKey:  publicKey,
		vapidPrivateKey: privateKey,
		vapidSubject:    subject,
		adminEmail:      adminEmail,
		domain:          domain,
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

func (s *Service) SendCloseNotification(ctx context.Context, userID int64, tag string) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil
	}

	payload := NotificationPayload{
		Tag: tag,
		Data: map[string]interface{}{
			"type": "close",
			"tag":  tag,
		},
	}

	return s.sendToUser(userID, payload)
}

func (s *Service) SendMedicationNotification(ctx context.Context, userID int64, med store.Medication, scheduledTime time.Time, intakeID int64) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil // Web push disabled
	}

	name := med.Name
	if med.Dosage != "" {
		name += " " + med.Dosage
	}

	title := "Time to take medication"
	body := name

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/icons/icon-192.png",
		Badge: "/static/icons/icon-192.png", // Monochrome badge preferred, but using icon for now
		Tag:   fmt.Sprintf("medication-%d", intakeID),
		Data: map[string]interface{}{
			"type":          "medication_individual",
			"scheduled_at":  scheduledTime.Format(time.RFC3339),
			"medication_id": med.ID,
			"intake_id":     intakeID,
		},
		Actions: []NotificationAction{
			{Action: fmt.Sprintf("confirm_%d", intakeID), Title: "Confirm"},
			{Action: fmt.Sprintf("skip_%d", intakeID), Title: "Skip"},
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
		Icon:  "/static/icons/icon-192.png",
		Tag:   "low-stock",
		Data: map[string]interface{}{
			"type": "low_stock",
		},
	}

	return s.sendToUser(userID, payload)
}

func (s *Service) SendWorkoutNotification(ctx context.Context, userID int64, session *store.WorkoutSession, group *store.WorkoutGroup, variant *store.WorkoutVariant) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		slog.Debug("WebPush: Skipping workout notification (VAPID not configured)", "userID", userID, "sessionID", session.ID)
		return nil
	}

	title := "Time to Workout!"
	body := fmt.Sprintf("%s - %s", group.Name, variant.Name)

	slog.Info("WebPush: Preparing workout notification", "userID", userID, "sessionID", session.ID, "body", body)

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/icons/icon-192.png",
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

	err := s.sendToUser(userID, payload)
	if err != nil {
		slog.Error("WebPush: Error sending workout notification", "userID", userID, "sessionID", session.ID, "error", err)
		return err
	}

	slog.Info("WebPush: Successfully sent workout notification", "userID", userID, "sessionID", session.ID)
	return nil
}

func (s *Service) SendBPReminderNotification(ctx context.Context, userID int64, enhanced bool) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil
	}

	title := "Time to measure your blood pressure"
	body := "Please take a moment to measure and record your BP."
	if enhanced {
		body = "⚠️ Your recent readings have been higher than usual. Please measure your BP."
	}

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/icons/icon-192.png",
		Tag:   "bp-reminder",
		Data: map[string]interface{}{
			"type":     "bp_reminder",
			"enhanced": enhanced,
		},
		Actions: []NotificationAction{
			{Action: "bp_confirm", Title: "Add BP Reading"},
			{Action: "bp_snooze", Title: "Snooze 2h"},
			{Action: "bp_dontbug", Title: "Don't Bug Me"},
		},
	}

	return s.sendToUser(userID, payload)
}

// SendWeightReminderNotification sends a weight reminder notification via Web Push
func (s *Service) SendWeightReminderNotification(ctx context.Context, userID int64) error {
	if s.vapidPublicKey == "" || s.vapidPrivateKey == "" {
		return nil
	}

	title := "Time to track your weight"
	body := "It's been about a week since your last measurement. Stay on track with your goals!"

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/icons/icon-192.png",
		Tag:   "weight-reminder",
		Data: map[string]interface{}{
			"type": "weight_reminder",
		},
		Actions: []NotificationAction{
			{Action: "weight_confirm", Title: "Add Weight"},
			{Action: "weight_snooze", Title: "Snooze 2h"},
			{Action: "weight_dontbug", Title: "Don't Bug Me"},
		},
	}

	return s.sendToUser(userID, payload)
}

// SendNotification sends an arbitrary notification payload to all subscriptions for a user.
func (s *Service) SendNotification(userID int64, payload NotificationPayload) error {
	return s.sendToUser(userID, payload)
}

func (s *Service) sendToUser(userID int64, payload NotificationPayload) error {
	subs, err := s.store.GetPushSubscriptions(userID)
	if err != nil {
		return err
	}

	if len(subs) == 0 {
		return ErrNoSubscriptions
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	// Send to all user subscriptions and wait for results.
	// Return an error only if every subscription fails, so that a single stale
	// endpoint does not suppress delivery to working endpoints.
	var (
		mu           sync.Mutex
		successCount int
		lastErr      error
		wg           sync.WaitGroup
	)
	for _, sub := range subs {
		wg.Add(1)
		go func(subscription store.PushSubscription) {
			defer wg.Done()
			if err := s.sendToSubscription(subscription, payloadBytes); err != nil {
				mu.Lock()
				lastErr = err
				mu.Unlock()
				return
			}
			mu.Lock()
			successCount++
			mu.Unlock()
		}(sub)
	}
	wg.Wait()

	if successCount == 0 {
		if lastErr != nil {
			return lastErr
		}
		return fmt.Errorf("webpush: all subscription sends failed")
	}
	return nil
}

func (s *Service) sendToSubscription(sub store.PushSubscription, payload []byte) error {
	wpSub := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			Auth:   sub.Auth,
			P256dh: sub.P256dh,
		},
	}

	// Determine Subject based on Endpoint
	subject := s.vapidSubject

	// Apple Push Notification Service (APNs) often requires a URL-based subject (https://...)
	// whereas others (FCM, Mozilla) often prefer 'mailto:'.
	// If the user provided a URL in VAPID_SUBJECT, that's great for Apple.
	// If they provided a mailto, we might need to swap it for a URL for Apple?
	// Or vice-versa.
	// The user reported:
	// - VAPID_SUBJECT=https://... -> Works on iPhone, breaks Android/Web
	// - VAPID_SUBJECT=mailto:... -> Works on Android/Web, breaks iPhone

	isApple := strings.Contains(sub.Endpoint, "push.apple.com")

	if isApple {
		// Prefer URL
		if strings.HasPrefix(subject, "mailto:") {
			// Try to fallback to domain if available
			if s.domain != "" {
				subject = "https://" + s.domain
			}
		}
	} else {
		// Prefer mailto
		if strings.HasPrefix(subject, "http") || !strings.HasPrefix(subject, "mailto:") {
			// Try to fallback to admin email
			if s.adminEmail != "" {
				subject = "mailto:" + s.adminEmail
			}
		}
	}

	// Log the decision for debugging
	host := "unknown"
	if u, err := url.Parse(sub.Endpoint); err == nil {
		host = u.Host
	}
	slog.Info("WebPush: Sending notification", "host", host, "isApple", isApple, "subject", subject)

	resp, err := webpush.SendNotification(payload, wpSub, &webpush.Options{
		Subscriber:      subject,
		VAPIDPublicKey:  s.vapidPublicKey,
		VAPIDPrivateKey: s.vapidPrivateKey,
		TTL:             3600 * 12, // 12 hours
	})
	if err != nil {
		slog.Error("WebPush error", "endpoint", sub.Endpoint, "error", err)
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusGone {
		// Subscription is no longer valid
		slog.Info("WebPush subscription gone", "endpoint", sub.Endpoint)
		if err := s.store.DisablePushSubscription(sub.Endpoint); err != nil {
			slog.Error("Failed to disable subscription", "error", err)
		}
		return fmt.Errorf("webpush: subscription gone: %s", sub.Endpoint)
	} else if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		// Read response body for error details
		bodyBytes, readErr := io.ReadAll(resp.Body)
		if readErr == nil && len(bodyBytes) > 0 {
			slog.Warn("WebPush unexpected status", "statusCode", resp.StatusCode, "endpoint", sub.Endpoint, "response", string(bodyBytes))
		} else {
			slog.Warn("WebPush unexpected status", "statusCode", resp.StatusCode, "endpoint", sub.Endpoint)
		}
		return fmt.Errorf("webpush: unexpected status %d for %s", resp.StatusCode, sub.Endpoint)
	}
	return nil
}

// SendEarlyIntakeConfirmation sends a confirmation notification when user takes medication early
func (s *Service) SendEarlyIntakeConfirmation(ctx context.Context, userID int64, meds []store.Medication, scheduledTime, takenTime time.Time, intakeIDs []int64) error {
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

	title := "✅ Medication taken early"
	body := fmt.Sprintf("%s (scheduled for %s)", strings.Join(medNames, ", "), scheduledTime.Format("15:04"))

	payload := NotificationPayload{
		Title: title,
		Body:  body,
		Icon:  "/static/icons/icon-192.png",
		Badge: "/static/icons/icon-192.png",
		Tag:   fmt.Sprintf("medication-early-%s", scheduledTime.Format(time.RFC3339)),
		Data: map[string]interface{}{
			"type":             "medication_early_confirmed",
			"scheduled_at":     scheduledTime.Format(time.RFC3339),
			"taken_at":         takenTime.Format(time.RFC3339),
			"medication_ids":   medIDs,
			"medication_names": medNames,
			"intake_ids":       intakeIDs,
		},
		Actions: []NotificationAction{
			{Action: "cancel_intake", Title: "Cancel (Undo)"},
		},
	}

	return s.sendToUser(userID, payload)
}
