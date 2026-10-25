import { hasPlainCredentials } from "@/config/providerSecrets";
import { setting } from "@/config/settings";
import fs from "fs";
import { AppConfig, Config } from "@/types/domain";
import { ConfigProfile } from "@/models/ConfigProfile";
import { Token } from "@/models/Token";
import { logger } from "@/infra/logger";
import { slotFor, setActiveSlot } from "@/config/profileSlots";

function buildTlsConfig() {
  const cert = process.env.TLS_CERT_PATH;
  const key = process.env.TLS_KEY_PATH;
  if (!cert || !key) return undefined;
  try {
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  } catch (e) {
    logger.error(`[TLS] Failed to load cert/key: ${e}`);
    return undefined;
  }
}

const tlsConfig = buildTlsConfig();

export const serverProtocol: "http" | "https" = tlsConfig ? "https" : "http";

export const serverConfig = {
  host: "0.0.0.0",
  port: Number(process.env.PORT) || 3000,
  ...(tlsConfig ? { tls: tlsConfig } : {}),
  routes: {
    // ETag exposed so cross-origin clients (the Tizen build) can revalidate
    // /api/v2/epg/window with If-None-Match (already an allowed request header).
    cors: { origin: ["*"], additionalExposedHeaders: ["ETag"] },
    state: {
      parse: false,
      failAction: "ignore" as const,
    },
  },
};

const ConfigDefault: Config = {
  hostname: process.env.STALKER_HOST || "portal.example.com",
  port: Number(process.env.STALKER_PORT) || 80,
  https: process.env.STALKER_HTTPS === "true",
  contextPath: process.env.STALKER_PATH || "stalker_portal",
  mac: process.env.STALKER_MAC || "00:1A:79:00:00:00",
  stbType: process.env.STALKER_STB || "MAG254",
  groups: [],
  proxy: false,
  tokens: [],
  playCensored: process.env.PLAY_CENSORED === "true",
  providerType: "stalker",
  username: "user",
  password: "password",
};

const AppConfigDefault: AppConfig = {
  api: {
    timeout: Number(process.env.API_TIMEOUT) || 5000,
    retries: Number(process.env.API_RETRIES) || 3,
  },
  app: {
    name: "stalker-m3u-server",
    environment: process.env.NODE_ENV || "production",
    logLevel: process.env.LOG_LEVEL || "info",
  },
};

export const initialConfig: Config = { ...ConfigDefault };
export const appConfig: AppConfig = { ...AppConfigDefault };

// Field name on VOD items that marks them as series (value == 1 means series). A setting
// (Admin → Settings), so it is read on every use. Service keys (TMDB, OMDb, OpenSubtitles,
// SubDL) are settings too: read them with setting("tmdbToken") etc. (config/settings.ts).
export const seriesFlag = (): string => setting<string>("seriesFlag");

/** Providers whose links play directly (Xtream, M3U): relayed by the server, sent with a
 *  player's User-Agent; a Stalker portal hands out links through its own API instead. */
export function directLinks(): boolean {
  return initialConfig.providerType === "xtream" || initialConfig.providerType === "m3u";
}

export function getInitialConfig() {
  return initialConfig;
}

export function getAppConfig() {
  return appConfig;
}

export async function migrateToProfiles() {
  try {
    const existingProfiles = await ConfigProfile.count();
    if (existingProfiles === 0) {
      logger.info("No profiles found. Creating default profile...");
      await ConfigProfile.create({
        name: "Default Profile",
        description: "Initialized from defaults",
        config: ConfigDefault,
        isActive: true,
        isEnabled: true,
      });
      logger.info("✅ Migration complete: Created 'Default Profile'");
    }
  } catch (err) {
    logger.error({ err }, "Error during profile migration");
  }
}

/** Re-saves profiles whose provider credentials are still stored unencrypted. */
export async function encryptStoredCredentials() {
  try {
    const profiles = await ConfigProfile.findAll();
    if (!profiles.some((p) => hasPlainCredentials(p.getDataValue("config")))) return;
    // One-way change (an older build cannot read encrypted credentials): keep a copy first,
    // and stop if the copy fails rather than change data we cannot roll back.
    const { backupBeforeChange } = await import("@/services/backup");
    if (!(await backupBeforeChange("credential-encryption"))) {
      logger.error("[security] provider credentials left unencrypted this start: the safety copy failed");
      return;
    }
    let n = 0;
    for (const p of profiles) {
      if (!hasPlainCredentials(p.getDataValue("config"))) continue;
      p.config = p.config; // the model's setter encrypts
      p.changed("config", true);
      await p.save();
      n++;
    }
    if (n) logger.info(`[security] encrypted provider credentials in ${n} profile(s)`);
  } catch (err) {
    logger.error({ err }, "Could not encrypt stored provider credentials");
  }
}

export async function loadActiveProfileFromDB() {
  try {
    const activeProfile = await ConfigProfile.findOne({
      where: { isActive: true },
    });
    if (activeProfile) {
      Object.assign(initialConfig, activeProfile.config);
      setActiveSlot(await slotFor(activeProfile.id).catch((err) => {
        logger.error({ err }, `Profile "${activeProfile.name}" has no id range; using the portal's own ids`);
        return 0;
      }));

      logger.info(`✅ Loaded active profile: "${activeProfile.name}"`);

      const tokens = await Token.findAll();
      initialConfig.tokens = tokens.map((t) => t.token);
      logger.info(`Loaded ${initialConfig.tokens.length} tokens from DB.`);
    } else {
      logger.warn("⚠️ No active profile found. Using defaults.");
      Object.assign(initialConfig, ConfigDefault);
      setActiveSlot(0);
    }
  } catch (err) {
    logger.error({ err }, "Error loading active profile from DB");
  }
}

export async function switchProfile(profileId: number) {
  try {
    const profile = await ConfigProfile.findByPk(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    if (!profile.isEnabled)
      throw new Error(`Profile "${profile.name}" is disabled.`);
    // Before the switch, so a profile that cannot get an id range is not made active.
    await slotFor(profile.id);

    await ConfigProfile.update({ isActive: false }, { where: {} });

    profile.isActive = true;
    await profile.save();

    logger.info(`✅ Switched to profile: "${profile.name}"`);
    await loadActiveProfileFromDB();
    return profile;
  } catch (err) {
    logger.error({ err }, "Error switching profile");
    throw err;
  }
}

export async function saveProfileToDB(profileData: {
  name: string;
  description?: string;
  config: Config;
  isEnabled?: boolean;
}) {
  try {
    const profile = await ConfigProfile.create({
      name: profileData.name,
      description: profileData.description,
      config: profileData.config,
      isActive: false,
      isEnabled:
        profileData.isEnabled !== undefined ? profileData.isEnabled : true,
    });
    logger.info(`✅ Created profile: "${profile.name}"`);
    return profile;
  } catch (err) {
    logger.error({ err }, "Error saving profile to DB");
    throw err;
  }
}
