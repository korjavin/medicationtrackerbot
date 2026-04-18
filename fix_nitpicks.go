package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	content, err := os.ReadFile("internal/store/bp_reminders.go")
	if err != nil {
		fmt.Println("Error reading file:", err)
		return
	}

	code := string(content)

    // Fix rows.Err() in BatchGetBPReminderStates
    oldCode1 := `		}
		rows.Close()
	}

	return result, nil`
    newCode1 := `		}

		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	return result, nil`
    code = strings.Replace(code, oldCode1, newCode1, 1)

    // Fix rows.Err() in BatchGetLastBPReadings
    oldCode2 := `		}
		rows.Close()
	}

	return result, nil`
    newCode2 := `		}

		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	return result, nil`
    code = strings.Replace(code, oldCode2, newCode2, 1)

    // Fix Escape analysis in BatchGetBPReminderStates
    oldEscape1 := `			if snoozedUntil.Valid {
				state.SnoozedUntil = &snoozedUntil.Time
			}
			if dontRemindUntil.Valid {
				state.DontRemindUntil = &dontRemindUntil.Time
			}
			if lastNotificationSentAt.Valid {
				state.LastNotificationSentAt = &lastNotificationSentAt.Time
			}`
    newEscape1 := `			if snoozedUntil.Valid {
				t := snoozedUntil.Time
				state.SnoozedUntil = &t
			}
			if dontRemindUntil.Valid {
				t := dontRemindUntil.Time
				state.DontRemindUntil = &t
			}
			if lastNotificationSentAt.Valid {
				t := lastNotificationSentAt.Time
				state.LastNotificationSentAt = &t
			}`
    code = strings.Replace(code, oldEscape1, newEscape1, 1)

	err = os.WriteFile("internal/store/bp_reminders.go", []byte(code), 0644)
	if err != nil {
		fmt.Println("Error writing file:", err)
		return
	}
	fmt.Println("Successfully updated internal/store/bp_reminders.go")
}
