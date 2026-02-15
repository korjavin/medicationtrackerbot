package ui

import (
	"bytes"
	"fmt"

	"github.com/mdp/qrterminal/v3"
)

// RenderQR generates a QR code string for terminal display.
func RenderQR(content string) string {
	var buf bytes.Buffer
	qrterminal.GenerateWithConfig(content, qrterminal.Config{
		Level:     qrterminal.M,
		Writer:    &buf,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 2,
	})
	return buf.String()
}

// RenderPasskeyScreen renders the passkey enrollment screen with QR code.
func RenderPasskeyScreen(url string) string {
	var b bytes.Buffer

	title := TitleStyle.Render("Passkey Enrollment")
	fmt.Fprintln(&b, title)
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "Scan this QR code with your phone to set up your passkey:")
	fmt.Fprintln(&b)
	fmt.Fprint(&b, RenderQR(url))
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "Or open this URL in your browser:")
	fmt.Fprintln(&b, SuccessStyle.Render(url))
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, SubtitleStyle.Render("Press Enter when you've completed passkey enrollment..."))

	return b.String()
}
