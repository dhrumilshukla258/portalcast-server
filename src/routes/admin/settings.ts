import { listJobs, runJobNow } from "@/services/jobs";
import { ServerRoute } from "@hapi/hapi";
import nodemailer from "nodemailer";
import { requireAdmin } from "@/auth/jwt";
import { describeSettings, saveSetting, resetSetting, settingDef, setting, SettingError } from "@/config/settings";
import { recordFromRequest } from "@/services/SecurityEvents";
import { logger } from "@/infra/logger";

// Admin → Settings: every server setting (config/settings.ts). Under /api/admin/ (admin-gated
// in server.ts) and re-checked here. Secret values never leave the server: GET masks them,
// PUT accepts a new one, DELETE forgets the saved value. Every change is written to the
// security log with the setting's name, never its value.
export const settingsRoutes: ServerRoute[] = [
  {
    // Background jobs (services/jobs.ts): schedule, last result, "Run now".
    method: "GET",
    path: "/api/admin/jobs",
    handler: (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      return { items: listJobs() };
    },
  },
  {
    method: "POST",
    path: "/api/admin/jobs/{name}/run",
    handler: (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const name = String(request.params.name);
      if (!listJobs().some((j) => j.name === name)) return h.response({ error: "Unknown job" }).code(404);
      return { started: runJobNow(name), items: listJobs() };
    },
  },
  {
    method: "GET",
    path: "/api/admin/settings",
    handler: (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      return describeSettings();
    },
  },
  {
    method: "PUT",
    path: "/api/admin/settings/{key}",
    options: { payload: { maxBytes: 64 * 1024 } },
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return h.response({ error: "Forbidden" }).code(403);
      const key = String(request.params.key);
      if (!settingDef(key)) return h.response({ error: "Unknown setting" }).code(404);
      try {
        await saveSetting(key, (request.payload as any)?.value);
      } catch (e: any) {
        if (e instanceof SettingError) return h.response({ error: e.message }).code(400);
        throw e;
      }
      recordFromRequest(request, "setting_changed", `${key} saved`, (admin as any).userId ?? null);
      logger.info(`[settings] "${key}" changed in the admin page`);
      return describeSettings();
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/settings/{key}",
    handler: async (request, h) => {
      const admin = requireAdmin(request);
      if (!admin) return h.response({ error: "Forbidden" }).code(403);
      const key = String(request.params.key);
      if (!settingDef(key)) return h.response({ error: "Unknown setting" }).code(404);
      await resetSetting(key);
      recordFromRequest(request, "setting_changed", `${key} reset`, (admin as any).userId ?? null);
      logger.info(`[settings] "${key}" reset to the environment/default value`);
      return describeSettings();
    },
  },
  {
    // Sends a short test mail with the current SMTP settings to the address given (or the
    // admin email), and reports the mail server's own error when it fails.
    method: "POST",
    path: "/api/admin/settings/test-email",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      const to = String((request.payload as any)?.to || setting<string>("adminEmail") || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return h.response({ error: "Give an email address to send the test to" }).code(400);
      const host = setting<string>("smtpHost");
      const port = setting<number>("smtpPort");
      const user = setting<string>("smtpUser");
      const pass = setting<string>("smtpPass");
      if (!host || !user || !pass) return h.response({ error: "Fill in SMTP host, user and password first" }).code(400);
      try {
        const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
        await transporter.sendMail({
          from: setting<string>("smtpFrom") || `"Portalcast" <${user}>`,
          to,
          subject: "PortalCast test email",
          text: "Email from PortalCast works.",
        });
        return { ok: true, to };
      } catch (e: any) {
        return h.response({ error: `The mail server said: ${String(e?.message ?? e).slice(0, 300)}` }).code(502);
      }
    },
  },
];
