package pocketid

// User represents a Pocket-ID user.
type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	IsAdmin   bool   `json:"isAdmin"`
}

// CreateUserRequest is the request body for creating a user.
type CreateUserRequest struct {
	Username  string `json:"username"`
	Email     string `json:"email"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	IsAdmin   bool   `json:"isAdmin"`
}

// OIDCClient represents an OIDC client in Pocket-ID.
type OIDCClient struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Secret             string   `json:"secret,omitempty"`
	CallbackURLs       []string `json:"callbackURLs"`
	LogoutCallbackURLs []string `json:"logoutCallbackURLs"`
	IsPublic           bool     `json:"isPublic"`
	CreatedByUserID    string   `json:"createdByUserID,omitempty"`
}

// CreateOIDCClientRequest is the request body for creating an OIDC client.
type CreateOIDCClientRequest struct {
	Name               string   `json:"name"`
	CallbackURLs       []string `json:"callbackURLs"`
	LogoutCallbackURLs []string `json:"logoutCallbackURLs"`
	IsPublic           bool     `json:"isPublic"`
}

// OneTimeAccessToken represents a one-time access token response.
type OneTimeAccessToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

// SignupInitialAdminRequest is the request body for POST /api/signup/setup.
type SignupInitialAdminRequest struct {
	Username  string `json:"username"`
	Email     string `json:"email,omitempty"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName,omitempty"`
}

// CreateAPIKeyRequest is the request body for POST /api/api-keys.
type CreateAPIKeyRequest struct {
	Name      string `json:"name"`
	ExpiresAt string `json:"expiresAt"` // RFC 3339
}

// CreateAPIKeyResponse is the response from POST /api/api-keys.
type CreateAPIKeyResponse struct {
	ApiKey struct {
		ID string `json:"id"`
	} `json:"apiKey"`
	Token string `json:"token"`
}
