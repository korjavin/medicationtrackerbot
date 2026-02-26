package store

import (
	"context"
	"strconv"
)

func (s *Store) GetLatestChangeCursor(ctx context.Context) (int64, error) {
	var cursor int64
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id), 0) FROM change_events").Scan(&cursor); err != nil {
		return 0, err
	}
	return cursor, nil
}

func (s *Store) GetChangedTagsSince(ctx context.Context, since int64) (int64, []string, error) {
	cursor, err := s.GetLatestChangeCursor(ctx)
	if err != nil {
		return 0, nil, err
	}

	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT tag FROM change_events WHERE id > ? ORDER BY tag ASC", since)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	tags := make([]string, 0, 8)
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return 0, nil, err
		}
		tags = append(tags, tag)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}

	return cursor, tags, nil
}

// PruneChangeEvents removes old and excessive change events.
// keepLast: keep at least this many latest rows (0 disables count-based pruning).
// maxAgeDays: delete rows older than this many days (0 disables age-based pruning).
func (s *Store) PruneChangeEvents(ctx context.Context, keepLast, maxAgeDays int) error {
	if maxAgeDays > 0 {
		if _, err := s.db.ExecContext(ctx, "DELETE FROM change_events WHERE created_at < datetime('now', ?)", "-"+strconv.Itoa(maxAgeDays)+" days"); err != nil {
			return err
		}
	}

	if keepLast > 0 {
		if _, err := s.db.ExecContext(ctx, `
			DELETE FROM change_events
			WHERE id < COALESCE((
				SELECT MIN(id) FROM (
					SELECT id
					FROM change_events
					ORDER BY id DESC
					LIMIT ?
				)
			), 0)
		`, keepLast); err != nil {
			return err
		}
	}

	return nil
}
