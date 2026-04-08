package tzlookup

import (
	"fmt"
	"sync"

	"github.com/ringsaturn/tzf"
)

var (
	finder     tzf.F
	finderErr  error
	finderOnce sync.Once
)

func getFinderOrInit() (tzf.F, error) {
	finderOnce.Do(func() {
		finder, finderErr = tzf.NewDefaultFinder()
	})
	return finder, finderErr
}

// LookupTimezone returns the IANA timezone name for the given coordinates.
// Returns an error if the coordinates are invalid or no timezone is found.
func LookupTimezone(lat, lng float64) (string, error) {
	f, err := getFinderOrInit()
	if err != nil {
		return "", fmt.Errorf("tzlookup: init finder: %w", err)
	}
	tz := f.GetTimezoneName(lng, lat)
	if tz == "" {
		return "", fmt.Errorf("tzlookup: no timezone found for given coordinates")
	}
	return tz, nil
}
