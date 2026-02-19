package mcp

import "testing"

func TestIsSubjectAllowed(t *testing.T) {
	tests := []struct {
		name           string
		allowedSubject string
		subject        string
		want           bool
	}{
		{
			name:           "empty allows any subject",
			allowedSubject: "",
			subject:        "user-a",
			want:           true,
		},
		{
			name:           "single exact match",
			allowedSubject: "user-a",
			subject:        "user-a",
			want:           true,
		},
		{
			name:           "single mismatch",
			allowedSubject: "user-a",
			subject:        "user-b",
			want:           false,
		},
		{
			name:           "comma separated match first",
			allowedSubject: "user-a,user-b",
			subject:        "user-a",
			want:           true,
		},
		{
			name:           "comma separated match second with spaces",
			allowedSubject: "user-a, user-b",
			subject:        "user-b",
			want:           true,
		},
		{
			name:           "comma separated no match",
			allowedSubject: "user-a, user-b",
			subject:        "user-c",
			want:           false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OAuthHandler{
				config: &Config{
					AllowedSubject: tt.allowedSubject,
				},
			}

			got := h.isSubjectAllowed(tt.subject)
			if got != tt.want {
				t.Fatalf("isSubjectAllowed(%q) = %v, want %v", tt.subject, got, tt.want)
			}
		})
	}
}

func TestIsAudienceAllowed(t *testing.T) {
	tests := []struct {
		name        string
		serverURL   string
		clientIDs   string
		aud         string
		wantAllowed bool
	}{
		{
			name:        "matches server url",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a",
			aud:         "https://mcp.example.com",
			wantAllowed: true,
		},
		{
			name:        "matches single client id",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a",
			aud:         "client-a",
			wantAllowed: true,
		},
		{
			name:        "matches one of multiple client ids",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a, client-b",
			aud:         "client-b",
			wantAllowed: true,
		},
		{
			name:        "no match",
			serverURL:   "https://mcp.example.com",
			clientIDs:   "client-a, client-b",
			aud:         "client-c",
			wantAllowed: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &OAuthHandler{
				config: &Config{
					MCPServerURL: tt.serverURL,
					ClientID:     tt.clientIDs,
				},
			}

			got := h.isAudienceAllowed(tt.aud)
			if got != tt.wantAllowed {
				t.Fatalf("isAudienceAllowed(%q) = %v, want %v", tt.aud, got, tt.wantAllowed)
			}
		})
	}
}
