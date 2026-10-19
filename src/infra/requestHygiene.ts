// Shapes of request that have no legitimate use against this API: traversal, null bytes,
// script/SQL/command injection, well-known scanner paths and tools. Checked on the raw URL
// before routing (server.ts); a hit is rejected with 400 and counts toward a ban.

const MAX_URL_LENGTH = 4096;
const SUSPICIOUS_URL = [
  [/(^|[\/\\])\.\.([\/\\]|$)|%2e%2e[\/\\%]|%2e%2e$/i, "path traversal"],
  [/%00|\x00/, "null byte"],
  [/<\s*script|javascript:|vbscript:|on(load|error|click)\s*=/i, "script injection"],
  [/(\bunion\b[\s\/*]+\bselect\b|\bselect\b.+\bfrom\b.+--|;\s*(drop|alter|insert|update|delete)\s+(table|into|from)\b|'\s*or\s*'?1'?\s*=\s*'?1)/i, "sql injection"],
  [/\/etc\/passwd|\/proc\/self|\bcmd\.exe\b|\/bin\/sh\b|\$\{.*\}|\{\{.*\}\}/i, "command/template injection"],
  [/\/(wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|\.env|\.git\/|\.aws\/|actuator|cgi-bin)(\/|$|\?)/i, "scanner path"],
] as const;

/** Why a request looks hostile, or null. Checked before routing, on the raw URL. */
export function suspiciousRequestReason(rawUrl: string, userAgent: string | undefined): string | null {
  if (rawUrl.length > MAX_URL_LENGTH) return `url length ${rawUrl.length}`;
  let decoded = rawUrl;
  try { decoded = decodeURIComponent(rawUrl); } catch { return "malformed percent-encoding"; }
  for (const [re, why] of SUSPICIOUS_URL) if (re.test(rawUrl) || re.test(decoded)) return why;
  if (userAgent && /sqlmap|nikto|nmap|masscan|acunetix|nessus|dirbuster|gobuster|wpscan|zgrab/i.test(userAgent)) return `scanner user-agent`;
  return null;
}

