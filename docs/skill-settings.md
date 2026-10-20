# Settings, secrets, data folder and background jobs — Skill Reference

Every server setting can be changed in **Admin › Settings**; environment variables still work and act as the fallback. Added 2026-10-20 as phase 0 of the local-library plan.

Related: [[skill-admin-dashboard]], [[skill-auth-system]], [[skill-database]], [[skill-subtitles]]

## Files

| File | What it holds |
|---|---|
| `src/config/settings.ts` | The registry of every setting, `setting(key)`, save/reset, `describeSettings()` |
| `src/routes/admin/settings.ts` | `GET/PUT/DELETE /api/admin/settings[/key]`, `POST /api/admin/settings/test-email`, `GET /api/admin/jobs`, `POST /api/admin/jobs/{name}/run` |
| `src/config/providerSecrets.ts` | Encryption and masking of IPTV provider credentials |
| `src/infra/serverSecret.ts` | The server secret: `JWT_SECRET`, else a generated `secret.key` |
| `src/infra/paths.ts` | The data folder: database, key file, uploads, backups |
| `src/services/jobs.ts` | The background job runner |
| `src/services/backup.ts` | The nightly database backup job |

## Reading a setting

```ts
import { setting } from "@/config/settings";
const token = setting<string>("tmdbToken");
```

- Precedence: a value saved in the admin page, else the environment variable, else the default. Settings with `envWins` (only `trustedProxies`) keep the environment value when one is set, so a wrong value saved in the page cannot lock the admin out.
- Values are cached in memory and read synchronously. Read them where they are used, not into a module-level constant: a constant would freeze the value at startup and the admin page would have no effect.
- `loadSettings()` runs right after `initDB()` in `server.ts`. Before that, `setting()` returns the environment or default value.
- `onSettingChange(fn)` notifies on save and reset (used for the log level and the HTTP client timeout).
- **Adding a setting:** one entry in `DEFS` (key, env var, type, default, group, label, help, `secret`, `apply`, min/max/options). It appears in the admin page with no webui change.

## Storage of settings

One `system_config` row per saved setting, key `setting:<key>`: `{ v: value }`, or `{ enc: "<AES-GCM>" }` for secrets. Secrets are never returned in full: `GET /api/admin/settings` shows `••••` plus the last 4 characters. Saving and resetting are written to the security log as `setting_changed` (with the key, never the value; not counted toward bans).

Shown read-only in the page because they are needed before the server starts: the data folder, port, TLS files, thread pool size, the server secret's source and whether `ADMIN_PASSWORD` is set.

## The server secret

`JWT_SECRET` signs logins, keys the AES-GCM encryption of every stored secret (`src/auth/crypto.ts`) and signs image-proxy links. It is now optional: when unset, `serverSecret.ts` generates a random key once and keeps it as `<data folder>/secret.key` (mode 600). Installs that set `JWT_SECRET` keep using it. Changing or losing the key signs everyone out and makes saved secrets unreadable (they fall back to the environment or default, with a warning in the log). The backup job never copies the key file.

## First start

`src/routes/account/setup.ts`: with no admin account and no `ADMIN_PASSWORD`, the server is in setup mode (`needsSetup()`). The webui's login page shows **Create admin account** instead of sign-in (`GET /api/auth/setup/status`, `POST /api/auth/setup`: email, name, password of 10+ characters). It creates the admin user, saves the admin email setting and signs in. Once any admin exists, or `ADMIN_PASSWORD` is set, both refuse with 409, permanently. The first person to finish it becomes admin, so finish it right after installing. `POST /api/auth/setup` shares the login rate limit.

## Stream tokens and networks

`resolveStreamTokenFor(request, token)` (`src/services/StreamTokens.ts`) pins a token to the first address that uses it: any home-network (RFC1918) address may use a token first used at home, a token first used from a public address works only from that address. Wrong-network use returns null and is logged as `stream_token_wrong_network` (not bannable). Needs `trustedProxies` behind a reverse proxy, otherwise every request has the proxy's address and the rule has no effect.

## Provider credentials

The IPTV profile's password, user name, MAC, device ids and serial are stored as `enc:<AES-GCM>` inside `config_profiles.config`. The `ConfigProfile` model's getter and setter decrypt and encrypt, so `profile.config` is plain everywhere in code. Existing plain values are encrypted once at startup (`encryptStoredCredentials()`). `GET /api/config` and `/api/profiles` send the password as `********`; a form that sends the placeholder back keeps the stored password.

## Embedded subtitle probe

`/api/media/info` and `/api/media/subtitle` probe the file the `?t=` stream token was minted for (the token's `resource`). They used to probe a client-supplied `url=`, which let any signed-in user make the server open arbitrary addresses, including ones on the home network. `url=` is still accepted from older webuis and ignored. The upstream address is not logged.

## Data folder

`infra/paths.ts`: the data folder is the database's folder (`SQLITE_DB_PATH`, a file or a folder). It holds `database.db`, `secret.key`, `uploads/` (unless the legacy `DATABASE_PATH` is still set) and `backups/`. In Docker it is the `/app/data` volume.

## Background jobs

`registerJob({ name, label, dailyAtHour | everyMs, yieldToPlayback, run })`, then `startJobs()` after the server is listening.

- Jobs run one at a time.
- A job with `yieldToPlayback` waits while `streamTracker.count() > 0`, for at most 2 hours, so disk-heavy work never competes with someone watching.
- Admin › Settings lists each job with its schedule, last result or error, and a **Run now** button.
- Registered today: `backup` (04:00). The older timers in `server.ts` (EPG refresh, catalog warm-up, enrichment) still run on their own and move here as they are touched.

## Backups

`backupDatabase()` writes `portalcast-YYYY-MM-DD.db` with SQLite's `VACUUM INTO` (a consistent copy while the server keeps writing) to a temporary name, renames it into place and keeps the newest `backupKeep` (default 7; 0 = off). Folder: the `backupFolder` setting, default `<data folder>/backups`. Restore: stop the server, replace `database.db` with a backup, start it.
