## 2024-05-24 - Secure Oauth State Verification
**Vulnerability:** OAuth state parameter comparison in `handleOIDCCallback` was vulnerable to timing attacks due to the use of regular string inequality `!=`.
**Learning:** Oauth state verification should employ constant-time operations such as `subtle.ConstantTimeCompare`, as the state parameter functions as a security token against CSRF attacks. Relying on string comparison makes it susceptible to timing side-channel attacks that can theoretically allow an attacker to reconstruct the token.
**Prevention:** Always use `subtle.ConstantTimeCompare` (in Go) or `hmac.Equal` when comparing cryptographic secrets or tokens like signatures, hashes, and OAuth state values.
