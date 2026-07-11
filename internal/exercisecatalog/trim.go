// Package exercisecatalog trims the vendored hasaneyldrm/exercises-dataset
// source into a media-free, English-only static catalog shipped to the
// frontend as web/static/data/exercises-catalog.json.
//
// TEXT ONLY. The upstream media (image/gif_url/attribution, © Gym visual) is a
// separate commercial license and is deliberately dropped here — see
// third_party/exercises-dataset/SOURCE.md.
package exercisecatalog

import (
	"encoding/json"
	"fmt"
)

// SourceCommit pins the upstream commit the vendored source was taken from.
const SourceCommit = "118e4bd6b14da6df0e36605d7169b65db18389a4"

// srcExercise decodes only the fields we keep from the upstream record. Every
// other field (including the licensed media fields image/gif_url/attribution)
// is dropped by omission — encoding/json ignores unknown source keys.
type srcExercise struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	Category         string            `json:"category"`
	BodyPart         string            `json:"body_part"`
	Equipment        string            `json:"equipment"`
	MuscleGroup      string            `json:"muscle_group"`
	SecondaryMuscles []string          `json:"secondary_muscles"`
	Target           string            `json:"target"`
	Instructions     map[string]string `json:"instructions"`
}

// Exercise is one trimmed catalog entry (English instructions only).
type Exercise struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	BodyPart         string   `json:"body_part"`
	Category         string   `json:"category"`
	MuscleGroup      string   `json:"muscle_group"`
	SecondaryMuscles []string `json:"secondary_muscles"`
	Target           string   `json:"target"`
	Equipment        string   `json:"equipment"`
	InstructionsEn   string   `json:"instructions_en"`
}

// Catalog is the whole trimmed asset, with provenance so the pinned source is
// self-documenting in the shipped file.
type Catalog struct {
	Source    Source     `json:"source"`
	Exercises []Exercise `json:"exercises"`
}

type Source struct {
	Repo    string `json:"repo"`
	Commit  string `json:"commit"`
	License string `json:"license"`
}

// Trim reads the vendored upstream JSON array and returns the trimmed catalog
// as deterministic, minified JSON (byte-for-byte stable for a given input, so a
// drift test can compare it to the checked-in asset). Input record order is
// preserved and every field is a struct field (no maps in the output), so the
// bytes are reproducible.
func Trim(srcJSON []byte) ([]byte, error) {
	var src []srcExercise
	if err := json.Unmarshal(srcJSON, &src); err != nil {
		return nil, fmt.Errorf("decode upstream exercises: %w", err)
	}
	cat := Catalog{
		Source: Source{
			Repo:    "hasaneyldrm/exercises-dataset",
			Commit:  SourceCommit,
			License: "MIT (text only; Gym-visual media excluded)",
		},
		Exercises: make([]Exercise, 0, len(src)),
	}
	for _, s := range src {
		cat.Exercises = append(cat.Exercises, Exercise{
			ID:               s.ID,
			Name:             s.Name,
			BodyPart:         s.BodyPart,
			Category:         s.Category,
			MuscleGroup:      s.MuscleGroup,
			SecondaryMuscles: s.SecondaryMuscles,
			Target:           s.Target,
			Equipment:        s.Equipment,
			InstructionsEn:   s.Instructions["en"],
		})
	}
	out, err := json.Marshal(cat)
	if err != nil {
		return nil, fmt.Errorf("encode catalog: %w", err)
	}
	return append(out, '\n'), nil
}
