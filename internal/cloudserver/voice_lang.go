package cloudserver

import (
	"encoding/json"
	"strings"
	"unicode"
)

// voiceFallbackTexts are the spoken fallback sentences per language (the set
// elevenlabs-agent.js translates): hang-up, retry, and the anonymous voice
// trial's budget-spent sentence (bd med-o7zq.22).
var voiceFallbackTexts = map[string][3]string{
	"en": {"I lost the connection to your app — please hang up and call again.", "Sorry, I didn't catch that — could you say it again?", "Your free voice minutes are used up — please hang up."},
	"ru": {"Я потерял связь с вашим приложением — пожалуйста, положите трубку и перезвоните.", "Извините, я не расслышал — повторите, пожалуйста?", "Ваши бесплатные минуты голосовых звонков закончились — пожалуйста, положите трубку."},
	"uk": {"Я втратив зв'язок із вашим застосунком — будь ласка, покладіть слухавку й зателефонуйте знову.", "Вибачте, я не розчув — повторіть, будь ласка?", "Ваші безкоштовні хвилини голосових дзвінків закінчилися — будь ласка, покладіть слухавку."},
	"de": {"Ich habe die Verbindung zu deiner App verloren — bitte leg auf und ruf noch einmal an.", "Entschuldigung, das habe ich nicht verstanden — kannst du es bitte wiederholen?", "Deine kostenlosen Sprachminuten sind aufgebraucht — bitte leg auf."},
	"es": {"He perdido la conexión con tu app — por favor cuelga y vuelve a llamar.", "Perdona, no te he entendido — ¿puedes repetirlo?", "Se han agotado tus minutos de voz gratuitos — por favor cuelga."},
	"fr": {"J'ai perdu la connexion avec ton appli — raccroche et rappelle, s'il te plaît.", "Désolé, je n'ai pas compris — peux-tu répéter ?", "Tes minutes d'appel vocal gratuites sont épuisées — raccroche, s'il te plaît."},
}

// voiceLang guesses the caller's language from the last user message of a
// chat-completions payload. ponytail: script + diacritic heuristic, English
// default; short Latin-script utterances without markers fall back to English.
// The text is inspected in memory only, never logged.
func voiceLang(payload map[string]json.RawMessage) string {
	var msgs []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(payload["messages"], &msgs) != nil {
		return "en"
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role != "user" {
			continue
		}
		var text string
		if json.Unmarshal(msgs[i].Content, &text) != nil {
			var parts []struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(msgs[i].Content, &parts)
			for _, p := range parts {
				text += p.Text + " "
			}
		}
		return langOfText(text)
	}
	return "en"
}

func langOfText(s string) string {
	s = strings.ToLower(s)
	for _, r := range s {
		if unicode.Is(unicode.Cyrillic, r) {
			if strings.ContainsAny(s, "іїєґ") {
				return "uk"
			}
			return "ru"
		}
	}
	switch {
	case strings.ContainsAny(s, "äöüß"):
		return "de"
	case strings.ContainsAny(s, "ñ¿¡"):
		return "es"
	case strings.ContainsAny(s, "çèêëâîôûœ"):
		return "fr"
	}
	return "en"
}

func voiceHangUp(lang string) string { return voiceFallbackTexts[lang][0] }
func voiceRetry(lang string) string  { return voiceFallbackTexts[lang][1] }
func voiceMinutesUp(lang string) string {
	return voiceFallbackTexts[lang][2]
}
