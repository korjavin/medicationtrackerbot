package cloudserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// In-call photos on anonymous trial calls (bd med-adje), over the
// attest_voice_test.go fixtures.

// photoCall starts an anonymous call with an attached leg (hello read).
func (e *attestEnv) photoCall(t *testing.T, ctx context.Context) (string, *websocket.Conn) {
	t.Helper()
	e.voiceOn()
	k := attestKey(t)
	e.enrolled(k, "tok-p1")
	rec, out := e.voiceStart(k, 1)
	if rec.Code != http.StatusOK {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	device, err := dialAnonVoice(ctx, srv, out.Call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello
	return out.Call, device
}

// photoTurn is ElevenLabs' turn whose newest user message is last.
func (e *attestEnv) photoTurn(call, last string) *httptest.ResponseRecorder {
	return e.do("localhost", voiceLLMCompletionsPath,
		`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"},{"role":"user","content":"`+last+`"}],"elevenlabs_extra_body":{"call":"`+call+`"}}`, nil)
}

const testPhotoURL = "data:image/jpeg;base64,AAAA"

func wantImageFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, typ string, id int64) {
	t.Helper()
	if f := readVoiceFrame(t, ctx, conn); f.Type != typ || f.ID != id {
		t.Fatalf("frame = %+v, want %s #%d", f, typ, id)
	}
}

// The photo rides the device leg, is held for the next turn, goes to the trial
// VISION model on the marker message exactly once, and the tab hears how that
// turn went.
func TestAttestVoicePhotoAttachOnce(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	call, device := e.photoCall(t, ctx)

	// Not an image: refused, nothing held.
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 1, Type: "image", Data: "data:text/plain;base64,AAAA"})
	wantImageFrame(t, ctx, device, "image_error", 1)

	// A newer photo replaces (and fails) a held one.
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 2, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_queued", 2)
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 3, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_error", 2)
	wantImageFrame(t, ctx, device, "image_queued", 3)

	// The marker turn: vision model, the image on the newest user message only.
	if turn := e.photoTurn(call, voicePhotoMarker); turn.Code != http.StatusOK || !strings.Contains(turn.Body.String(), "spoken answer") {
		t.Fatalf("marker turn: %d %q", turn.Code, turn.Body.String())
	}
	var up struct {
		Model    string `json:"model"`
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	b, _ := e.lastBody.Load().(string)
	if err := json.Unmarshal([]byte(b), &up); err != nil || up.Model != "trial-vision-model" || len(up.Messages) != 3 {
		t.Fatalf("upstream = %s", b)
	}
	if strings.Count(b, testPhotoURL) != 1 || !strings.Contains(string(up.Messages[2].Content), `"image_url":{"url":"`+testPhotoURL+`"}`) {
		t.Fatalf("image not on the marker: %s", b)
	}
	wantImageFrame(t, ctx, device, "image_done", 3)

	// Attach-once: the re-asked marker turn is text-only.
	if turn := e.photoTurn(call, voicePhotoMarker); turn.Code != http.StatusOK {
		t.Fatalf("second turn: %d", turn.Code)
	}
	if b, _ := e.lastBody.Load().(string); strings.Contains(b, "image_url") || !strings.Contains(b, `"trial-model"`) {
		t.Fatalf("second turn upstream = %s", b)
	}

	// A held photo whose turn is not the marker's is dropped with an error.
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 4, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_queued", 4)
	e.photoTurn(call, "something else")
	if b, _ := e.lastBody.Load().(string); strings.Contains(b, "image_url") {
		t.Fatalf("non-marker turn carried the photo: %s", b)
	}
	wantImageFrame(t, ctx, device, "image_error", 4)

	// A refused turn (limiter) leaves it held for the re-sent one.
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 5, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_queued", 5)
	limiter := e.trial.streamLimiter
	e.trial.streamLimiter = newRateLimiter(0, time.Minute)
	e.photoTurn(call, voicePhotoMarker)
	e.trial.streamLimiter = limiter

	// The vision turn failing upstream settles the photo with an error.
	e.upstream.Store(500)
	if turn := e.photoTurn(call, voicePhotoMarker); !strings.Contains(turn.Body.String(), voiceRetry("en")) {
		t.Fatalf("failed turn: %q", turn.Body.String())
	}
	if b, _ := e.lastBody.Load().(string); !strings.Contains(b, testPhotoURL) {
		t.Fatalf("re-sent turn lost the photo: %s", b)
	}
	wantImageFrame(t, ctx, device, "image_error", 5)
}

// A 200 stream is not an answer by itself (Argus 14493): a stream that breaks
// before answering fails the photo, and ElevenLabs dropping the turn after the
// upstream headers but before any byte reached it keeps the photo held.
func TestAttestVoicePhotoStreamOutcome(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	call, device := e.photoCall(t, ctx)
	c := e.relay.lookup(call)

	// Upstream answers 200, then only an in-band error event.
	e.upstreamStream.Store(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"error\":{\"message\":\"overloaded\"}}\n\n"))
	})
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 1, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_queued", 1)
	e.photoTurn(call, voicePhotoMarker)
	wantImageFrame(t, ctx, device, "image_error", 1)

	// Upstream sends its 200 headers, then ElevenLabs hangs up the turn.
	headers := make(chan struct{})
	e.upstreamStream.Store(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(headers)
		<-r.Context().Done()
	})
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 2, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_queued", 2)
	turnCtx, hangUp := context.WithCancel(ctx)
	req := httptest.NewRequestWithContext(turnCtx, http.MethodPost, voiceLLMCompletionsPath, strings.NewReader(
		`{"model":"m","stream":true,"messages":[{"role":"user","content":"`+voicePhotoMarker+`"}],"elevenlabs_extra_body":{"call":"`+call+`"}}`))
	req.Host = "localhost"
	served := make(chan struct{})
	go func() {
		defer close(served)
		e.h.ServeHTTP(httptest.NewRecorder(), req)
	}()
	<-headers
	hangUp()
	<-served
	img := c.takeAnonImage()
	if img == nil || img.id != 2 {
		t.Fatalf("pre-answer hang-up lost the photo: %+v", img)
	}
}

// The photo frame is bounded by the leg's read limit: a frame that fits is
// held, an oversize one closes the leg before anything is held.
func TestAttestVoicePhotoFrameCap(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	call, device := e.photoCall(t, ctx)
	c := e.relay.lookup(call)

	frame := func(n int) voiceFrame {
		f := voiceFrame{ID: 1, Type: "image", Data: "data:image/jpeg;base64,"}
		empty, _ := json.Marshal(f)
		f.Data += strings.Repeat("A", n-len(empty))
		return f
	}
	sendVoiceFrame(t, ctx, device, frame(voiceMaxFrameBytes))
	wantImageFrame(t, ctx, device, "image_queued", 1)
	c.takeAnonImage()
	sendVoiceFrame(t, ctx, device, frame(voiceMaxFrameBytes+1))
	wantCloseCode(t, ctx, device, websocket.StatusMessageTooBig)
	if c.takeAnonImage() != nil {
		t.Fatal("oversize photo held")
	}
}

// A held photo never outlives the call: kept across a leg blip, dropped on
// reap and on grant exhaustion.
func TestAttestVoicePhotoDroppedOnReap(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	call, device := e.photoCall(t, ctx)
	c := e.relay.lookup(call)
	held := func(c *voiceCall) bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.anon.image != nil
	}

	sendVoiceFrame(t, ctx, device, voiceFrame{ID: 1, Type: "image", Data: testPhotoURL})
	wantImageFrame(t, ctx, device, "image_queued", 1)
	_ = device.Close(websocket.StatusGoingAway, "") // a blip: detached, within grace
	waitLegDetached(t, c)
	if !held(c) {
		t.Fatal("photo dropped within the grace")
	}
	e.reapNow(call)
	if held(c) {
		t.Fatal("reaped call still holds the photo")
	}
	// A late requeue (a turn that was in flight) cannot bring it back.
	c.requeueAnonImage(&anonImage{id: 1, url: testPhotoURL})
	if held(c) {
		t.Fatal("requeue after the drop held the photo")
	}

	exhausted := &voiceCall{
		anon: &anonVoice{image: &anonImage{id: 2, url: testPhotoURL}},
		now:  time.Now,
	}
	e.relay.exhaustAnon(exhausted)
	if held(exhausted) {
		t.Fatal("exhausted call still holds the photo")
	}
}
