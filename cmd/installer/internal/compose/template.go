package compose

import "embed"

//go:embed docker-compose.yml.tmpl
var templateFS embed.FS

const templateName = "docker-compose.yml.tmpl"
