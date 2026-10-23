// Every server setting in one place, editable from the admin page (Admin → Settings).
//
// Precedence for each setting: a value saved in the admin page, else the environment
// variable, else the built-in default. A few settings flagged `envWins` keep the
// environment value when one is set, as an escape hatch (TRUSTED_PROXIES: a wrong value
// saved in the page could lock the admin out). Values are cached in memory and read
// synchronously, so callers use `setting("key")` wherever they used `process.env.X`; a save
// takes effect on the next read, without a restart, except the few marked `restart`.
//
// Storage: one `system_config` row per saved setting, key `setting:<key>`, value
// `{ v: <value> }`, or `{ enc: <AES-GCM> }` for secrets (auth/crypto.ts, the same scheme
// as users' subtitle keys). Secrets are never sent back to the admin page in full.

import { serverSecretSource } from "@/infra/serverSecret";
import { dataDir } from "@/infra/paths";
import { SystemConfig } from "@/models/SystemConfig";
import { encryptSecret, decryptSecret } from "@/auth/crypto";
import { logger } from "@/infra/logger";
import { Op } from "sequelize";

export type SettingType = "string" | "number" | "boolean" | "list";

export interface SettingDef {
  key: string;
  env?: string;
  type: SettingType;
  default: string | number | boolean | string[];
  group: string;
  label: string;
  help?: string;
  secret?: boolean;
  /** "live": next read sees the change; "restart": applied at the next server start. */
  apply: "live" | "restart";
  /** The environment value, when set, beats a saved value (escape hatch). */
  envWins?: boolean;
  min?: number;
  max?: number;
  /** Allowed values for a string setting. */
  options?: string[];
}

const DEFS: SettingDef[] = [
  // Metadata services
  { key: "tmdbToken", env: "TMDB_API_READ_TOKEN", type: "string", default: "", secret: true, group: "Metadata services", label: "TMDB read access token", help: "Posters, backdrops, cast, genres and matching. Without it, enrichment is off.", apply: "live" },
  { key: "omdbKeys", env: "OMDB_API_KEY", type: "list", default: [], secret: true, group: "Metadata services", label: "OMDb API keys", help: "Rotten Tomatoes and Metacritic scores. Several keys, comma-separated, are used one after another.", apply: "live" },
  { key: "omdbDailyLimit", env: "OMDB_DAILY_LIMIT", type: "number", default: 900, min: 0, max: 100000, group: "Metadata services", label: "OMDb calls per key per day", help: "A free key allows 1,000 a day. 0 turns OMDb off.", apply: "live" },
  { key: "tvmazeEnabled", type: "boolean", default: true, group: "Metadata services", label: "Use TVmaze", help: "Descriptions and cast for series TMDB does not know. Public API, no key.", apply: "live" },
  { key: "openSubtitlesKey", env: "OPENSUBTITLES_API_KEY", type: "string", default: "", secret: true, group: "Metadata services", label: "OpenSubtitles API key", help: "Server-wide key; a user's own key in their settings takes priority.", apply: "live" },
  { key: "subdlKey", env: "SUBDL_API_KEY", type: "string", default: "", secret: true, group: "Metadata services", label: "SubDL API key", help: "Second subtitle source.", apply: "live" },

  // Email
  { key: "smtpHost", env: "SMTP_HOST", type: "string", default: "", group: "Email", label: "SMTP host", help: "Empty turns email off (approval and password-reset mails).", apply: "live" },
  { key: "smtpPort", env: "SMTP_PORT", type: "number", default: 587, min: 1, max: 65535, group: "Email", label: "SMTP port", help: "465 uses TLS from the start; other ports upgrade with STARTTLS.", apply: "live" },
  { key: "smtpUser", env: "SMTP_USER", type: "string", default: "", group: "Email", label: "SMTP user", apply: "live" },
  { key: "smtpPass", env: "SMTP_PASS", type: "string", default: "", secret: true, group: "Email", label: "SMTP password", apply: "live" },
  { key: "smtpFrom", env: "SMTP_FROM", type: "string", default: "", group: "Email", label: "Sender", help: "Defaults to \"Portalcast\" <SMTP user>.", apply: "live" },

  // Sign-in
  { key: "adminEmail", env: "ADMIN_EMAIL", type: "string", default: "", group: "Sign-in", label: "Admin email", help: "Signs in as admin and receives account-approval mails.", apply: "live" },
  { key: "adminEmails", env: "ADMIN_EMAILS", type: "list", default: [], group: "Sign-in", label: "More admin emails", help: "Comma-separated.", apply: "live" },
  { key: "googleClientId", env: "GOOGLE_CLIENT_ID", type: "string", default: "", group: "Sign-in", label: "Google sign-in client id", help: "Empty turns Google sign-in off.", apply: "live" },

  // Security
  { key: "rateLimitMax", env: "RATE_LIMIT_MAX", type: "number", default: 120, min: 10, max: 100000, group: "Security", label: "Stream requests per window, per address", apply: "live" },
  { key: "rateLimitWindowMs", env: "RATE_LIMIT_WINDOW_MS", type: "number", default: 60000, min: 1000, max: 3600000, group: "Security", label: "Stream rate-limit window (ms)", apply: "live" },
  { key: "adminLoginRateLimitMax", env: "ADMIN_LOGIN_RATE_LIMIT_MAX", type: "number", default: 5, min: 1, max: 1000, group: "Security", label: "Admin login attempts per window", apply: "live" },
  { key: "adminLoginRateLimitWindowMs", env: "ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS", type: "number", default: 300000, min: 10000, max: 86400000, group: "Security", label: "Admin login window (ms)", apply: "live" },
  { key: "banAfterFailures", env: "SECURITY_BAN_AFTER", type: "number", default: 20, min: 3, max: 10000, group: "Security", label: "Auto-ban after failures (in 15 minutes)", apply: "live" },
  { key: "banMinutes", env: "SECURITY_BAN_MINUTES", type: "number", default: 60, min: 1, max: 525600, group: "Security", label: "Auto-ban length (minutes)", apply: "live" },
  { key: "allowDirectStreams", env: "ALLOW_DIRECT_STREAMS", type: "boolean", default: false, group: "Security", label: "Allow direct streams", help: "Lets clients be redirected to the provider's CDN. Off keeps every stream behind the server.", apply: "live" },

  // Network
  { key: "publicBaseUrl", env: "PUBLIC_BASE_URL", type: "string", default: "", group: "Network", label: "Public base URL", help: "For example https://stream.example.com. Empty: taken from each request.", apply: "live" },
  { key: "trustedProxies", env: "TRUSTED_PROXIES", type: "string", default: "", group: "Network", label: "Trusted proxies", help: "\"private\", or addresses/CIDRs, comma-separated. A value set in the environment always wins.", apply: "live", envWins: true },
  { key: "allowedOrigins", env: "ALLOWED_ORIGINS", type: "list", default: [], group: "Network", label: "Allowed origins for the live connection", help: "Comma-separated. Empty: same origin only.", apply: "restart" },

  // Provider tuning
  { key: "apiTimeoutMs", env: "API_TIMEOUT", type: "number", default: 5000, min: 500, max: 600000, group: "Provider tuning", label: "Stream request timeout (ms)", apply: "live" },
  { key: "apiRetries", env: "API_RETRIES", type: "number", default: 3, min: 0, max: 10, group: "Provider tuning", label: "Stream request retries", apply: "live" },
  { key: "providerTimeoutMs", env: "PROVIDER_TIMEOUT", type: "number", default: 120000, min: 1000, max: 600000, group: "Provider tuning", label: "Portal request timeout (ms)", apply: "live" },
  { key: "seriesFlag", env: "SERIES_FLAG", type: "string", default: "is_series", group: "Provider tuning", label: "Field that marks series", help: "Portal field whose value 1 marks a VOD item as a series.", apply: "live" },
  { key: "cbFailureThreshold", env: "CB_FAILURE_THRESHOLD", type: "number", default: 5, min: 1, max: 1000, group: "Provider tuning", label: "Circuit breaker: failures to open", apply: "live" },
  { key: "cbFailureWindowMs", env: "CB_FAILURE_WINDOW_MS", type: "number", default: 60000, min: 1000, max: 3600000, group: "Provider tuning", label: "Circuit breaker: window (ms)", apply: "live" },
  { key: "cbCooldownMs", env: "CB_COOLDOWN_MS", type: "number", default: 30000, min: 1000, max: 3600000, group: "Provider tuning", label: "Circuit breaker: cooldown (ms)", apply: "live" },
  { key: "streamIdleTimeoutMs", env: "STREAM_IDLE_TIMEOUT_MS", type: "number", default: 60000, min: 5000, max: 3600000, group: "Provider tuning", label: "\"Now watching\" ends after idle (ms)", apply: "live" },
  { key: "portalBackgroundGapMs", env: "PORTAL_BACKGROUND_GAP_MS", type: "number", default: 1000, min: 0, max: 60000, group: "Provider tuning", label: "Pause between background portal requests (ms)", help: "The guide download, catalog warm and catch-up send one request at a time with this pause between, so a first setup on a big portal takes hours instead of flooding it. When the portal answers \"too many requests\" (429) they pause and slow down further by themselves. Playing never waits for it.", apply: "live" },
  { key: "epgBatchDelayMs", env: "EPG_FETCH_BATCH_DELAY_MS", type: "number", default: 500, min: 0, max: 60000, group: "Provider tuning", label: "Pause between guide batches (ms)", apply: "live" },
  { key: "epgEmptyRecheckHours", env: "EPG_EMPTY_RECHECK_HOURS", type: "number", default: 72, min: 0, max: 720, group: "Provider tuning", label: "Ask channels without a guide again after (hours)", help: "Many channels have no guide at all (80% on one large portal). A channel that had none at two guide refreshes in a row is asked again only after this many hours, instead of at every refresh; one that gets a guide is picked up then, and new channels are always asked. \"Refresh guide\" in Admin still asks every channel. 0 asks every channel every time.", apply: "live" },

  // Local libraries
  { key: "mediaRoots", type: "list", default: ["/media"], group: "Local libraries", label: "Media roots", help: "Folders inside the container that libraries may use (the NAS mounts in the compose file). The folder browser shows nothing outside them.", apply: "live" },

  // Images
  { key: "imageCacheGb", type: "number", default: 200, min: 0, max: 2000, group: "Images", label: "TMDB image cache size (GB)", help: "Artwork is downloaded from TMDB once and served from this server. 0 turns the cache off (apps load TMDB directly).", apply: "live" },
  { key: "chartCountry", env: "CHART_COUNTRY", type: "string", default: "US", group: "Catalog", label: "Default country for charts", help: "Two letters (US, IN, GB…). Home's charts (Netflix Top 10, in cinemas, popular on streaming services) follow each viewer's languages: Hindi or Tamil gives India, Korean South Korea. This country is used for English and for new viewers.", apply: "live" },
  { key: "catalogSnapshot", type: "boolean", default: false, group: "Catalog", label: "In-memory catalog", help: "All Movies/Series, search, Discover, title details and people are answered from a packed copy of the catalog in memory instead of the database: faster pages and about 200 MB less JavaScript heap. Kept current by itself (rebuilt in the background after changes). Memory: on a large catalog (130k titles) the copy is about 200 MB and a rebuild briefly needs about 450 MB more, so give the container about 1.5 GB (Docker mem_limit 1536m, NODE_OPTIONS=--max-old-space-size=1024). Off: answered as before.", apply: "restart" },
  { key: "imdbMatching", type: "boolean", default: false, group: "Catalog", label: "Match titles with IMDb first", help: "Downloads IMDb's free title files (about 1.9 GB, from datasets.imdbws.com; for personal, non-commercial use) once a week and builds an index next to the database (about 170 MB). New titles are then matched against it before TMDB is searched, using the portal's director, cast and year as evidence: more titles found, fewer wrong matches, fewer TMDB searches. Titles never matched are tried again, and matches the portal's own director, cast or year contradict are corrected, a few hundred at a time. Off: titles are searched on TMDB only, as before.", apply: "live" },
  { key: "imageCacheFolder", type: "string", default: "", group: "Images", label: "Image cache folder", help: "Empty: image-cache inside the data folder. A NAS folder mounted into the container is a good choice.", apply: "live" },
  { key: "customArtFolder", type: "string", default: "", group: "Images", label: "Custom images folder", help: "Posters, backdrops and logos chosen or uploaded in \"Edit images\". Empty: custom-art inside the data folder. Move the existing files there before changing it.", apply: "live" },

  // Playback
  { key: "browserFallback", type: "boolean", default: true, group: "Playback", label: "Browser fallback for local files", help: "Local files the browser cannot play (AC3/DTS/TrueHD audio, AVI) reach the webui as HLS: video copied untouched, audio converted to AAC. The TV always gets the original file.", apply: "live" },

  // Backups
  { key: "backupFolder", type: "string", default: "", group: "Backups", label: "Backup folder", help: "Where the nightly database copy goes. Empty: the backups folder inside the data folder. A NAS folder mounted into the container is a good choice. The key file is never copied here.", apply: "live" },
  { key: "backupKeep", type: "number", default: 7, min: 0, max: 365, group: "Backups", label: "Nightly backups to keep", help: "0 turns backups off.", apply: "live" },

  // Sports
  { key: "sportsLeagues", type: "list", default: ["cricket", "ipl", "tennis", "premier-league", "champions-league", "la-liga", "formula-1", "nba", "nfl"], group: "Sports", label: "Sports schedule: leagues", help: "The Sports page's leagues for viewers who have not chosen their own (each viewer can pick from every league in Sports, Choose sports): names from sporting-events.org/data (for example premier-league, bundesliga, tennis, the-ashes). Comma-separated, at most 20. The schedule is fetched hourly while Sports is in use.", apply: "live" },

  // Logging
  { key: "logLevel", env: "LOG_LEVEL", type: "string", default: "info", options: ["debug", "info", "warn", "error"], group: "Logging", label: "Log level", apply: "live" },
];

const BY_KEY = new Map(DEFS.map((d) => [d.key, d]));
const ROW_PREFIX = "setting:";

/** Saved values, decrypted, by key. Filled by loadSettings(); empty means env/default. */
const saved = new Map<string, unknown>();
const listeners: ((key: string) => void)[] = [];

function parse(def: SettingDef, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (def.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : String(raw).trim().toLowerCase() === "true";
    case "list":
      return (Array.isArray(raw) ? raw : String(raw).split(",")).map((s) => String(s).trim()).filter(Boolean);
    default:
      return String(raw);
  }
}

function envValue(def: SettingDef): unknown {
  if (!def.env) return undefined;
  const raw = process.env[def.env];
  if (raw === undefined || raw === "") return undefined;
  return parse(def, raw);
}


/** The current value of a setting: saved, else environment, else default. */
export function setting<T = any>(key: string): T {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting "${key}"`);
  const env = envValue(def);
  if (def.envWins && env !== undefined) return env as T;
  if (saved.has(key)) return saved.get(key) as T;
  if (env !== undefined) return env as T;
  return def.default as T;
}

export function settingSource(key: string): "admin" | "environment" | "default" {
  const def = BY_KEY.get(key)!;
  const env = envValue(def);
  if (def.envWins && env !== undefined) return "environment";
  if (saved.has(key)) return "admin";
  return env !== undefined ? "environment" : "default";
}

/** Called after a setting changes (saved or reset). */
export function onSettingChange(fn: (key: string) => void): void {
  listeners.push(fn);
}

function notify(key: string) {
  for (const fn of listeners) {
    try { fn(key); } catch (e: any) { logger.error(`[settings] listener for ${key}: ${e?.message ?? e}`); }
  }
}

/** Reads every saved setting into memory. Called once after the database is ready. */
export async function loadSettings(): Promise<void> {
  const rows = (await SystemConfig.findAll({ where: { key: { [Op.like]: `${ROW_PREFIX}%` } }, raw: true })) as any[];
  for (const row of rows) {
    const key = String(row.key).slice(ROW_PREFIX.length);
    const def = BY_KEY.get(key);
    if (!def) continue;
    let value: any = typeof row.value === "string" ? safeJson(row.value) : row.value;
    try {
      if (value && typeof value.enc === "string") value = { v: JSON.parse(decryptSecret(value.enc)) };
    } catch {
      logger.warn(`[settings] "${key}" could not be decrypted (JWT_SECRET changed?); using the environment or default`);
      continue;
    }
    const parsed = parse(def, value?.v);
    if (parsed !== undefined) saved.set(key, parsed);
  }
  for (const key of saved.keys()) notify(key);
  logger.info(`[settings] ${saved.size} setting(s) saved in the admin page`);
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export class SettingError extends Error {}

/** Validates and saves a setting. Returns the parsed value. */
export async function saveSetting(key: string, raw: unknown): Promise<unknown> {
  const def = BY_KEY.get(key);
  if (!def) throw new SettingError(`Unknown setting "${key}"`);
  const value = parse(def, raw);
  if (value === undefined) throw new SettingError(`"${def.label}" needs a ${def.type}`);
  if (def.type === "number") {
    const n = value as number;
    if (def.min !== undefined && n < def.min) throw new SettingError(`"${def.label}" must be at least ${def.min}`);
    if (def.max !== undefined && n > def.max) throw new SettingError(`"${def.label}" must be at most ${def.max}`);
  }
  if (def.options && !def.options.includes(value as string)) throw new SettingError(`"${def.label}" must be one of ${def.options.join(", ")}`);
  if (key === "publicBaseUrl" && value) {
    try {
      const u = new URL(value as string);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      throw new SettingError("Public base URL must look like https://stream.example.com");
    }
  }
  const stored = def.secret ? { enc: encryptSecret(JSON.stringify(value)) } : { v: value };
  await SystemConfig.upsert({ key: ROW_PREFIX + key, value: stored });
  saved.set(key, value);
  notify(key);
  return value;
}

/** Forgets the saved value, so the environment or default applies again. */
export async function resetSetting(key: string): Promise<void> {
  if (!BY_KEY.has(key)) throw new SettingError(`Unknown setting "${key}"`);
  await SystemConfig.destroy({ where: { key: ROW_PREFIX + key } });
  saved.delete(key);
  notify(key);
}

function mask(value: unknown): string {
  const s = Array.isArray(value) ? value.join(",") : String(value ?? "");
  if (!s) return "";
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
}

/** Shown read-only in the admin page: set in Docker or the environment only. */
const FIXED = [
  { key: "dataFolder", label: "Data folder", value: () => dataDir, help: "Database, key file, uploads and backups. Set in the compose file (SQLITE_DB_PATH)." },
  { key: "port", label: "Port inside the container", value: () => String(Number(process.env.PORT) || 3000), help: "Set in the compose file; the port mapping there must match." },
  { key: "https", label: "HTTPS certificate", value: () => (process.env.TLS_CERT_PATH ? "set" : "not set (plain HTTP; a reverse proxy usually adds HTTPS)"), help: "TLS_CERT_PATH and TLS_KEY_PATH in the compose file." },
  { key: "threadPool", label: "Thread pool size", value: () => process.env.UV_THREADPOOL_SIZE || "4", help: "UV_THREADPOOL_SIZE; read before the server starts." },
  { key: "jwtSecret", label: "Encryption and login key", value: () => (serverSecretSource === "environment" ? "set in the environment (JWT_SECRET)" : "generated, kept in the data folder (secret.key)"), help: "Signs logins and encrypts saved secrets; changing it signs everyone out and makes saved secrets unreadable. Keep a copy of secret.key somewhere safe." },
  { key: "adminPassword", label: "Recovery admin password", value: () => (process.env.ADMIN_PASSWORD ? "set" : "not set"), help: "ADMIN_PASSWORD. An emergency way in if a setting locks you out." },
];

/** Every setting as the admin page shows it: secrets masked, with where each value comes from. */
export function describeSettings() {
  return {
    settings: DEFS.map((d) => {
      const value = setting(d.key);
      return {
        key: d.key,
        group: d.group,
        label: d.label,
        help: d.help ?? null,
        type: d.type,
        env: d.env ?? null,
        secret: Boolean(d.secret),
        apply: d.apply,
        envWins: Boolean(d.envWins),
        min: d.min ?? null,
        max: d.max ?? null,
        options: d.options ?? null,
        source: settingSource(d.key),
        value: d.secret ? mask(value) : value,
        isSet: Array.isArray(value) ? value.length > 0 : value !== "" && value !== null && value !== undefined,
      };
    }),
    fixed: FIXED.map((f) => ({ key: f.key, label: f.label, value: f.value(), help: f.help })),
  };
}

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

// The log level applies the moment it is saved.
onSettingChange((key) => {
  if (key !== "logLevel") return;
  try {
    (logger as any).level = setting<string>("logLevel");
  } catch { /* pino rejects an unknown level; the save already validated it */ }
});
