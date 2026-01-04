# Medication Tracker Bot

A private, self-hosted Telegram Mini App for medication tracking, designed to replace mobile health apps.

## Chat Commands
- `/start` - Launch the Mini App to manage medications.
- `/log` - Manually log a dose. Useful for "As Needed" medications or if you missed a notification.
- `/help` - Show instructions and available commands.

## Features

- **Medication Management**: Add, edit, and archive medications.
- **Scheduling**: Set custom schedules for each medication.
- **Smart Notifications**: Telegram notifications when it's time to take meds.
- **Repeat Reminders**: If not confirmed, notifications repeat after a configured interval.
- **Chat-based Confirmation**: Interact directly with the bot via Inline Buttons to confirm intake.
- **Management Web UI**: Mini App for adding meds and viewing history.
- **Privacy First**: Single-user architecture. Your data stays on your server.

## Tech Stack

- **Backend**: Go (Golang)
- **Database**: SQLite (Native Go)
- **Frontend**: Vanilla HTML/CSS/JS (Served by Go)
- **Platform**: Telegram Bot API + Mini Apps

## Configuration

The application is configured via Environment Variables:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot Token obtained from BotFather |
| `ALLOWED_USER_ID` | The Telegram User ID (integer) of the owner. Only this user can interact with the bot. |
| `DB_PATH` | Path to the SQLite database file (default: `meds.db`) |
| `PORT` | HTTP port for the web server (default: `8080`) |

## Quick Start

### Local Development

1.  Clone the repository.
2.  Set up environment variables (create a `.env` file or export them).
3.  Run the bot:
    ```bash
    go run ./cmd/bot
    ```

### Docker Deployment

```yaml
version: '3'
services:
  app:
    build: .
    volumes:
      - ./data:/app/data
    environment:
      - TELEGRAM_BOT_TOKEN=your_token
      - ALLOWED_USER_ID=123456789
    restart: always
```

## Security

This application utilizes Telegram's authentication mechanism for Mini Apps (`WebAppData`). It validates the integrity of the data using the Bot Token.

**Vital**: The API endpoints are protected and will only serve data if the request is authenticated and originates from the `ALLOWED_USER_ID`.
