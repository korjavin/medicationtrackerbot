package bot

import (
	"net/http"
	"net/http/httptest"
	"testing"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

func BenchmarkDeleteMessagesSequential(b *testing.B) {
	s, err := store.New(":memory:")
	if err != nil {
		b.Fatalf("failed to create store: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer server.Close()

	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")
	a := newStoreAdapter(s)

	bot := &Bot{
		api:           api,
		// adapter for bot multi-repo interfaces
		meds:          a,
		medSvc:        domain.NewMedicationService(s.Medication),
		bp:            a,
		weight:        a,
		workouts:      a,
		workoutSvc:    workoutsvc.New(s.Workout, s.TZ),
		exerciseSvc:   domain.NewExerciseService(s.Workout),
		reminderSvc:   domain.NewReminderService(a),
		food:          a,
		imports:       a,
		allowedUserID: 123456,
	}

	chatID := int64(123456)
	numMessages := 10
	msgIDs := make([]int, numMessages)
	for i := 0; i < numMessages; i++ {
		msgIDs[i] = 1000 + i
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, msgID := range msgIDs {
			_, _ = bot.api.Request(tgbotapi.NewDeleteMessage(chatID, msgID))
		}
	}
}

func BenchmarkDeleteMessagesParallel(b *testing.B) {
	s, err := store.New(":memory:")
	if err != nil {
		b.Fatalf("failed to create store: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer server.Close()

	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")
	a := newStoreAdapter(s)

	bot := &Bot{
		api:           api,
		// adapter for bot multi-repo interfaces
		meds:          a,
		medSvc:        domain.NewMedicationService(s.Medication),
		bp:            a,
		weight:        a,
		workouts:      a,
		workoutSvc:    workoutsvc.New(s.Workout, s.TZ),
		exerciseSvc:   domain.NewExerciseService(s.Workout),
		reminderSvc:   domain.NewReminderService(a),
		food:          a,
		imports:       a,
		allowedUserID: 123456,
	}

	chatID := int64(123456)
	numMessages := 10
	msgIDs := make([]int, numMessages)
	for i := 0; i < numMessages; i++ {
		msgIDs[i] = 1000 + i
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bot.deleteMessagesParallel(chatID, msgIDs, 0)
	}
}
