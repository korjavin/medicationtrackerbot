package main

import (
	"fmt"
	"time"
)

func main() {
	val := "2024-12-03 01:20:00 +0100"
	layout := "2006-01-02 15:04:05 -0700"
	t, err := time.Parse(layout, val)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
	} else {
		fmt.Printf("Success: %v\n", t)
	}
}
