package config

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	domainRegexp   = regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$`)
	botTokenRegexp = regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]{35}$`)
	emailRegexp    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

// ValidateDomain checks if a string is a valid domain name.
func ValidateDomain(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("domain cannot be empty")
	}
	if !domainRegexp.MatchString(s) {
		return fmt.Errorf("invalid domain format: %s", s)
	}
	return nil
}

// ValidateBotToken checks if a string looks like a Telegram bot token.
func ValidateBotToken(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("bot token cannot be empty")
	}
	if !botTokenRegexp.MatchString(s) {
		return fmt.Errorf("invalid bot token format (expected 123456:ABC-DEF...)")
	}
	return nil
}

// ValidateUserID checks if a string is a positive integer.
func ValidateUserID(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("user ID cannot be empty")
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return fmt.Errorf("user ID must be a positive integer")
	}
	return nil
}

// ValidateEmail checks if a string looks like an email address.
func ValidateEmail(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("email cannot be empty")
	}
	if !emailRegexp.MatchString(s) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

// ValidateNonEmpty checks that a string is not empty.
func ValidateNonEmpty(s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("this field cannot be empty")
	}
	return nil
}

// ValidateInstallDir checks if an install directory path is reasonable.
func ValidateInstallDir(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("install directory cannot be empty")
	}
	if !strings.HasPrefix(s, "/") {
		return fmt.Errorf("install directory must be an absolute path")
	}
	return nil
}
