package mcp

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"
)

// AuditEvent represents a single data access event by an MCP tool.
type AuditEvent struct {
	DataType  string    `json:"data_type"`
	StartDate time.Time `json:"start_date"`
	EndDate   time.Time `json:"end_date"`
}

// DataTypeSummary aggregates multiple accesses for the same data type.
type DataTypeSummary struct {
	Label string    `json:"label"`
	From  time.Time `json:"from"`
	To    time.Time `json:"to"`
}

// AuditPayload is the JSON structure sent to the main bot container.
type AuditPayload struct {
	DataTypes   []DataTypeSummary `json:"data_types"`
	RequestedAt time.Time         `json:"requested_at"`
}

// AuditBuffer accumulates tool usage events and flushes them periodically.
type AuditBuffer struct {
	mu       sync.Mutex
	events   []AuditEvent
	endpoint string
	secret   string
	client   *http.Client
}

// NewAuditBuffer creates a new audit buffer.
func NewAuditBuffer(endpoint, secret string) *AuditBuffer {
	return &AuditBuffer{
		endpoint: endpoint,
		secret:   secret,
		client:   &http.Client{Timeout: 10 * time.Second},
	}
}

// Record adds a new event to the buffer.
func (b *AuditBuffer) Record(event AuditEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, event)
}

// Flush merges events by data type, computes HMAC, and POSTs to the bot endpoint.
func (b *AuditBuffer) Flush() {
	b.mu.Lock()
	if len(b.events) == 0 {
		b.mu.Unlock()
		return
	}
	eventsToFlush := make([]AuditEvent, len(b.events))
	copy(eventsToFlush, b.events)
	b.events = b.events[:0]
	b.mu.Unlock()

	// Merge overlapping date ranges by DataType
	merged := make(map[string]DataTypeSummary)
	for _, ev := range eventsToFlush {
		if existing, ok := merged[ev.DataType]; ok {
			if ev.StartDate.Before(existing.From) {
				existing.From = ev.StartDate
			}
			if ev.EndDate.After(existing.To) {
				existing.To = ev.EndDate
			}
			merged[ev.DataType] = existing
		} else {
			merged[ev.DataType] = DataTypeSummary{
				Label: ev.DataType,
				From:  ev.StartDate,
				To:    ev.EndDate,
			}
		}
	}

	payload := AuditPayload{
		DataTypes:   make([]DataTypeSummary, 0, len(merged)),
		RequestedAt: time.Now().UTC(),
	}

	for _, v := range merged {
		payload.DataTypes = append(payload.DataTypes, v)
	}

	// Sort for deterministic output (useful for testing and readability)
	sort.Slice(payload.DataTypes, func(i, j int) bool {
		return payload.DataTypes[i].Label < payload.DataTypes[j].Label
	})

	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[MCP Audit] Error marshaling payload: %v", err)
		return
	}

	// Compute HMAC-SHA256
	mac := hmac.New(sha256.New, []byte(b.secret))
	mac.Write(body)
	signature := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequest("POST", b.endpoint, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[MCP Audit] Error creating request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", signature)

	resp, err := b.client.Do(req)
	if err != nil {
		log.Printf("[MCP Audit] Error sending notification: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[MCP Audit] Endpoint returned status %d", resp.StatusCode)
	} else {
		log.Printf("[MCP Audit] Successfully flushed %d events", len(eventsToFlush))
	}
}

// Start runs a periodic flush goroutine.
func (b *AuditBuffer) Start(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Minute)
	go func() {
		for {
			select {
			case <-ticker.C:
				b.Flush()
			case <-ctx.Done():
				ticker.Stop()
				b.Flush() // Flush remaining events before exiting
				return
			}
		}
	}()
}
