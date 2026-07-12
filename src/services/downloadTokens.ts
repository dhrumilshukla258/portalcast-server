import { mintStreamToken } from "@/services/StreamTokens";

// `/api/v2/download` can't require a Bearer header — it's opened via
// `window.open`, a plain navigation. So the download target (id/series/cmd/
// path) is encoded into a token's resource server-side, behind a JWT-gated
// mint step, instead of trusting client-supplied id/cmd/path query params
// directly (which previously let anyone fetch+stream an arbitrary URL with
// zero auth — a real open-proxy/SSRF gap).
export interface DownloadPayload {
  id?: string;
  series?: string;
  isSeries?: boolean;
  cmd?: string;
  path?: string;
  title?: string;
}

export const mintDownloadToken = (payload: DownloadPayload, userLabel: string): string =>
  mintStreamToken(JSON.stringify(payload), userLabel, undefined, {
    kind: payload.isSeries ? "series" : "movie",
    label: payload.title,
  });
