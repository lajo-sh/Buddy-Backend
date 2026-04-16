Env Variables

This file documents the environment variables used by the Buddy Backend.

Guidelines

- If a variable is required, the app will throw or fail to initialize (see code references).
- Many values are multi-line (PEM keys). When placing them in a .env file, ensure the newlines are preserved or use a method that supports multi-line values (for example, base64-encoding or loading from a file).

Core variables

- DATABASE_URL — Required — string
  - Purpose: Postgres connection string used by Drizzle ORM.
  - Example: `postgres://user:pass@localhost:5432/buddy`

- REDIS_HOST — Required — string
  - Purpose: Hostname of Redis used for queues/cache.
  - Example: `127.0.0.1`

- REDIS_PORT — Required — integer
  - Purpose: TCP port for Redis.
  - Example: `6379`

- REDIS_DB — Optional — integer (default: 0)
  - Purpose: Redis database index. Defaults to 0 when not set.
  - Example: `0`

- REDIS_PASSWORD — Required if your Redis instance requires auth — string
  - Purpose: Password for Redis AUTH.
  - Example: `s3cr3t`

Authentication / JWT

- JWT_PRIVATE_KEY — Required — PKCS#8 PEM string
  - Purpose: Private key used to sign RS256 JWTs for user/device tokens.
  - Format: PEM PKCS#8 (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)
  - Example (truncated): `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANB...\n-----END PRIVATE KEY-----`

- JWT_PUBLIC_KEY — Required — SPKI PEM string
  - Purpose: Public key used to verify RS256 JWTs (used by WebSocket auth and other verification code).
  - Format: PEM SPKI (-----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----)
  - Example (truncated): `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----`

- RESET_PASSWORD_JWT_SECRET — Required — string (used as HMAC secret)
  - Purpose: HS256 secret used to sign password-reset tokens (short-lived, 1 hour).
  - Notes: The code encodes this with TextEncoder; use a high-entropy string. 32+ random bytes recommended.
  - Example: `xk2q9...very-long-random-string...`

Google Sign-In

- GOOGLE_CLIENT_ID — Required if using Google signin — string
  - Purpose: OAuth client ID used to validate Google ID tokens.
  - Example: `1234567890-abc.apps.googleusercontent.com`

Email / SMTP

- SMTP_HOST — Required — string
  - Purpose: SMTP server hostname used to create Nodemailer transporter.
  - Example: `smtp.sendgrid.net`

- SMTP_PORT — Required — integer
  - Purpose: SMTP server port. Must be a valid TCP port number.
  - Example: `587`

- SMTP_SECURE — Optional — string flag ("1" for true)
  - Purpose: When set to `"1"` the transporter will use secure mode (TLS). Otherwise TLS is disabled.
  - Example: `1`

- SMTP_USER — Required — string
  - Purpose: SMTP username for authentication.
  - Example: `apikey` (SendGrid)

- SMTP_PASS — Required — string
  - Purpose: SMTP password for authentication.
  - Example: `SG.xxxxx`

- SMTP_EMAIL — Optional but recommended — string (email)
  - Purpose: Default "from" address used when sending verification / reset emails.
  - Example: `Buddy <no-reply@buddy.example>` or `buddy@example.com`

Application base

- BASE_URL — Required for hosted reset page links — string (URL)
  - Purpose: Base URL of the running Buddy frontend / app used to construct password reset links.
  - Behavior: Trailing slashes are trimmed in code.
  - Example: `https://buddy.example`

AI provider

- NODE_ENV — Optional — string (commonly `development` or `production`)
  - Purpose: Determines whether the app uses API-based providers (production) or Ollama (development).
  - Example: `production`

- AI_PROVIDER — Optional — string (`openai` or `anthropic`)
  - Purpose: Explicitly sets the production provider. If omitted, the app auto-detects provider from API key/base URL.
  - Example: `anthropic`

- AI_API_KEY — Recommended in production — string
  - Purpose: Provider API key for the selected provider. `OPENAI_API_KEY` is also supported for backward compatibility.
  - Example (OpenAI): `sk-...`
  - Example (Anthropic/Claude): `sk-ant-...`

- AI_API_BASE_URL — Optional in production — string
  - Purpose: Provider base URL. If not set, defaults to provider standard endpoint (`https://api.openai.com/v1` or `https://api.anthropic.com/v1`).
  - Example: `https://api.anthropic.com/v1`

- AI_MODEL_NAME — Recommended in production — string
  - Purpose: Model name passed to the provider API.
  - Example (OpenAI): `gpt-4o-mini`
  - Example (Anthropic/Claude): `claude-haiku-4-5-20251001`

- OPENAI_API_KEY — Backward compatible alias for `AI_API_KEY` — string
  - Purpose: Legacy key still accepted by the code.

- OPENAI_API_BASE_URL — Backward compatible alias for `AI_API_BASE_URL` — string
  - Purpose: Legacy base URL still accepted by the code.

- OPENAI_MODEL_NAME — Backward compatible alias for `AI_MODEL_NAME` — string
  - Purpose: Legacy model name still accepted by the code.

- ANTHROPIC_MODEL_NAME — Optional fallback alias — string
  - Purpose: Additional fallback model variable for Anthropic.

- OPENAI_API_BASE_URL — Required in production if using a custom base URL — string
  - Purpose: Base URL for OpenAI API requests. If not set, default OpenAI endpoint is used by the SDK.
  - Example: `https://api.openai.com/v1`

- OPENAI_MODEL_NAME — Required in production — string
  - Purpose: Model name passed into the SDK (for example: `gpt-4o-mini` or `gpt-4.1`).
  - Example: `gpt-4o-mini`

Logging (Loki)

These are only used when NODE_ENV === "production" (Loki transport is enabled):

- LOKI_HOST — Required in production if using Loki — string (URL)
  - Purpose: Loki host URL for pino-loki transport.
  - Example: `https://loki.example.com`

- LOKI_USERNAME — Required in production if using Loki — string
  - Purpose: Basic auth username for Loki.

- LOKI_PASSWORD — Required in production if using Loki — string
  - Purpose: Basic auth password for Loki.

Other

- (Implicit) PORT — The app currently listens on port 3000 (hard-coded). If you want to run behind a different port, use your process manager or reverse proxy. The source calls `app.listen(3000)`.

Quick .env example

Example minimal .env for local development (replace placeholders with real values):

```
DATABASE_URL=postgres://user:pass@localhost:5432/buddy
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=yourredispassword

JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
RESET_PASSWORD_JWT_SECRET=some-very-long-random-secret

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=smtp-user
SMTP_PASS=smtp-pass
SMTP_EMAIL=buddy@example.com
BASE_URL=https://buddy.example

# For Google sign-in (optional)
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com

# For AI provider in production (OpenAI or Claude)
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL_NAME=claude-haiku-4-5-20251001
AI_API_BASE_URL=https://api.anthropic.com/v1

# Loki (only in production)
LOKI_HOST=https://loki.example.com
LOKI_USERNAME=loki-user
LOKI_PASSWORD=loki-pass

NODE_ENV=development
```

If you prefer not to embed PEM values in an environment file, consider loading them from a file at startup and setting the corresponding environment variable to the file contents (preserving newlines) or base64-encoding the key and decoding at runtime.

If you'd like, I can also add a sample .env.example to the repo or adjust the code to allow loading PEMs from files.
