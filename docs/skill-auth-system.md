# Auth System — Skill Reference

This doc captures the full authentication system implemented in `feature/dual-portal-xtream-support` (commit `54846ea`). Reference this before touching anything in `src/routes/account/auth.ts`, `src/auth/jwt.ts`, `src/auth/password.ts`, `src/auth/email.ts`, or `src/models/User.ts` / `src/models/DeviceCode.ts`.

---

## Overview

Two login methods: **Google OAuth** and **email/password**. Both share the same JWT token system and the same admin-approval gate for non-admin users.

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth audience for verifying ID tokens |
| `ADMIN_EMAIL` | Primary admin email (auto-bootstrapped as admin) |
| `ADMIN_EMAILS` | Comma-separated list of additional admin emails |
| `ADMIN_PASSWORD` | Env-level admin password (bypasses DB check) |
| `JWT_SECRET` | Secret used to sign/verify all JWTs |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Nodemailer config for approval emails |

---

## Auth Flow

### Google OAuth (`POST /api/auth/google`)
1. Frontend passes a Google `idToken` + `clientType` (`"web"` or `"tv"`)
2. Server verifies token with `google-auth-library`
3. If email matches `ADMIN_EMAIL` / `ADMIN_EMAILS` → auto-bootstrap or promote to admin, skip approval
4. New non-admin user → created as `isActive: false`, admin approval email sent via SMTP → returns `403`
5. Existing inactive user → returns `403` (pending approval)
6. Existing active user → issues tokens

### Email/Password Login (`POST /api/auth/login`)
- Admin check: if email is in admin list AND password matches `ADMIN_PASSWORD` → auto-bootstrap admin and issue tokens (no DB password needed)
- Regular users: `verifyPassword(password, user.passwordHash, user.salt)` using PBKDF2
- Users without `passwordHash` are Google-only → returns hint to use Google Sign-In

### Signup (`POST /api/auth/signup`)
- Creates user as `isActive: false`, sends admin approval email
- Admin must activate via `PUT /api/admin/users/{id}` with `isActive: true`
- Activation triggers `sendUserApprovedEmail` to notify the user

All three successful-login paths above (Google, admin-bootstrap, email/password) set `user.lastLogin = new Date()` before issuing tokens — see [[skill-user-system]] / [[skill-admin-dashboard]].

### Token Refresh (`POST /api/auth/refresh`)
- Accepts a refresh token, verifies it has `type: "refresh"`
- Issues a new access token; refresh token is reused (not rotated)

---

## JWT Tokens

- **Access token:** 1 hour TTL, contains `{ userId, email, role }`
- **Refresh token:** 30 days (web) or 6 months (TV), contains `{ userId, type: "refresh", clientType }`
- **Stream token:** 30-day TTL, contains `{ sub: userId, scope: "stream" }` — returned as `user_info.password` in Xtream `player_api.php` responses so IPTV players never carry the real password in stream URLs. See [[skill-xtream-provider]] for details.
- All protected routes call `authCheck(request)` from `src/auth/jwt.ts` which reads `Authorization: Bearer <token>`

---

## Device Code Flow (TV Auth)

TV clients can't do browser-based OAuth. Flow:

1. TV calls `POST /api/auth/device/code` → gets `{ deviceCode, userCode, verificationUrl, expiresIn: 300 }`
2. `userCode` is a human-friendly `ABC-DEF` format (6 chars, readable alphabet only)
3. User opens `verificationUrl` (e.g. `http://server/#/verify?code=ABC-DEF`) on their phone/PC, authenticates there
4. TV polls `POST /api/auth/device/poll` with `{ deviceCode }` every few seconds
5. Poll returns `{ status: "pending" | "authorized" | "expired" }` — when authorized, includes tokens
6. `DeviceCode` records expire after 5 minutes — expired rows are purged by the daily `runDbCleanup()` job (`src/server.ts`, see [[skill-database]]), not by this flow itself

### Webui entry points into `/verify`

Two ways a user reaches the code-entry screen (`portalcast-webui`'s `Verify.tsx`):
- **Already logged in**: the header profile dropdown has an explicit "Authorize a Device" entry that navigates straight there.
- **Not logged in**: the logged-out Home page's "Have a TV Pairing Code?" button navigates to `/verify`, which immediately bounces to `/login?redirect=/verify?code=...` since authorization requires being logged in first.

### UX bugs fixed (webui)

- **Login-history loop**: `Login.tsx`'s "already logged in → forward to redirectPath" effect, and the Google/credentials login-success handlers, all used a plain history *push* (`navigate(redirectPath)`). Since the "already logged in" effect re-fires every time `/login` is (re)mounted — including via the browser Back button — a plain push meant every Back press landed back on `/login`, which immediately pushed forward again, trapping the user in a loop that could never reach whatever page existed before Login. Fixed by using `navigate(redirectPath, { replace: true })` everywhere a post-login redirect happens, including on `/verify`'s own post-authorization redirect.
- **QR tab shown where it shouldn't be**: arriving at `/login` via `/verify`'s not-logged-in bounce (`redirect=/verify?code=...`) means the visitor already has a pairing code to type in — they need real credentials, not a second TV code. `Login.tsx` now detects this (`redirectPath.startsWith('/verify')`) and forces the credentials tab, hiding the QR/TV tab entirely for that path. Without this fix, picking the QR tab there generated an unrelated second code that, once approved, bounced back to `/verify` instead of into the app.
- **`/verify` no longer strands the user**: on successful authorization, the page used to show a static "TV Authorized!" confirmation requiring a manual "Go to Web Portal" click. It now auto-redirects to `/` after ~1.8s (still with the manual button available for anyone who doesn't want to wait) — relevant now that an already-logged-in user can reach this page via the header entry point above, not just a logged-out phone scanning a QR with nothing else to do.

---

## User Roles

| Role | Permissions |
|------|------------|
| `admin` | Full access to `/api/admin/*` routes; auto-activated |
| `user` | Access to `/api/user/*` routes; requires admin activation |

Admin self-protection guards prevent: disabling own account, downgrading own role, deleting own account.

---

## API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/google` | Google OAuth login |
| `POST` | `/api/auth/login` | Email/password login |
| `POST` | `/api/auth/signup` | Register (creates inactive user) |
| `POST` | `/api/auth/refresh` | Refresh access token |
| `POST` | `/api/auth/device/code` | Get device code (TV) |
| `POST` | `/api/auth/device/poll` | Poll for TV auth result |
| `POST` | `/api/auth/device/authorize` | Authorize a device code (from an already-logged-in browser) |

---

## Key Files

- `src/routes/account/auth.ts` — all auth endpoints
- `src/auth/jwt.ts` — `createJWT`, `verifyJWT`, `authCheck`
- `src/auth/password.ts` — `hashPassword`, `verifyPassword` (PBKDF2)
- `src/auth/email.ts` — `sendAdminApprovalRequest`, `sendUserApprovedEmail` (nodemailer)
- `src/models/User.ts` — User Sequelize model
- `src/models/DeviceCode.ts` — DeviceCode Sequelize model