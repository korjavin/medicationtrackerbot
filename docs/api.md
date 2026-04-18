# API Endpoints

## Health Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bootstrap` | All initial data in one request |
| GET | `/api/medications` | List medications |
| POST | `/api/medications` | Create medication |
| PATCH | `/api/medications/:id` | Update medication |
| POST | `/api/medications/confirm-schedule` | Confirm dose intake |
| POST | `/api/medications/log-past` | Log a past intake (returns full `IntakeLog`; routed through `MedicationService.LogMedicationAt`) |
| GET | `/api/history` | Intake history (filter by `days`, `med_id`) |
| GET | `/api/medications/next-intake` | Next scheduled dose |
| GET | `/api/bp` | BP readings |
| POST | `/api/bp` | Log BP reading |
| GET | `/api/bp/stats` | BP statistics |
| GET | `/api/bp/goal` | BP goal |
| POST | `/api/bp/goal` | Set BP goal |
| GET | `/api/weight` | Weight logs |
| POST | `/api/weight` | Log weight |
| GET | `/api/weight/goal` | Weight goal |
| POST | `/api/weight/goal` | Set weight goal |
| GET | `/api/food/log` | Food log entries |
| POST | `/api/food/log` | Log food |
| GET | `/api/food/search` | Search Open Food Facts |
| GET | `/api/food/targets` | Nutrition targets |
| POST | `/api/food/targets` | Set nutrition targets |
| GET | `/api/sleep` | Sleep logs |
| POST | `/api/sleep` | Log sleep |
| GET | `/api/notes` | List diary notes |
| POST | `/api/notes` | Create diary note |
| DELETE | `/api/notes/{id}` | Delete diary note |

## Workouts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workout/groups` | List workout groups |
| POST | `/api/workout/groups/create` | Create group |
| PUT | `/api/workout/groups/update` | Update group |
| GET | `/api/workout/variants` | List variants |
| POST | `/api/workout/variants/create` | Create variant |
| GET | `/api/workout/exercises` | List exercises |
| POST | `/api/workout/exercises/create` | Create exercise |
| PUT | `/api/workout/exercises/update` | Update exercise |
| DELETE | `/api/workout/exercises/delete` | Delete exercise |
| GET | `/api/workout/sessions` | Session history |
| GET | `/api/workout/sessions/details` | Session details with logs |
| GET | `/api/workout/stats` | 30-day statistics |
| GET | `/api/workout/rotation/state` | Current rotation position |
| POST | `/api/workout/rotation/initialize` | Initialize rotation |

## System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/changes` | Change events since cursor (for cache invalidation) |
| GET | `/auth/status` | Check if session is authenticated (returns `{"authenticated": bool}`) |
| GET | `/api/settings` | User settings (returns `{"timezone": "..."}`) |
| POST | `/api/settings` | Update settings (accepts optional `timezone` IANA name; 400 on invalid values) |
| POST | `/api/push/subscribe` | Register push subscription |
| POST | `/api/push/unsubscribe` | Remove push subscription |
| GET | `/auth/oidc/login` | OIDC login redirect |
| GET | `/auth/oidc/callback` | OIDC callback |
| GET | `/auth/google/login` | Google login redirect |
| GET | `/auth/google/callback` | Google callback |
| GET/POST | `/auth/telegram/callback` | Telegram Login Widget auth (GET: redirect flow, 302; POST: JSON callback) |
