package scheduler

import (
	"encoding/json"
	"sync"
	"testing"
)

func BenchmarkUnmarshalDaysOfWeek(b *testing.B) {
	str := "[1, 3, 5]"
	for i := 0; i < b.N; i++ {
		var daysOfWeek []int
		_ = json.Unmarshal([]byte(str), &daysOfWeek)
	}
}

func BenchmarkCachedDaysOfWeek(b *testing.B) {
	str := "[1, 3, 5]"
	cache := make(map[string][]int)
	cache[str] = []int{1, 3, 5}
	var mu sync.RWMutex

	for i := 0; i < b.N; i++ {
		var daysOfWeek []int
		mu.RLock()
		if cached, ok := cache[str]; ok {
			daysOfWeek = cached
			mu.RUnlock()
		} else {
			mu.RUnlock()
			_ = json.Unmarshal([]byte(str), &daysOfWeek)
			mu.Lock()
			cache[str] = daysOfWeek
			mu.Unlock()
		}
		_ = daysOfWeek
	}
}
