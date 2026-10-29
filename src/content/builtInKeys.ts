// Keys built into official builds, so a fresh install works without signing up anywhere
// (owner 2026-10-29: subtitle search "free", as in other players). They come from GitHub
// secrets at build time (tsup.config.ts `define`; the release and Docker workflows pass
// them) and are never in the repository. A key set in Admin › Settings, or a user's own
// key, always wins. Builds without the secret (forks, local) simply have none.

declare const __PORTALCAST_OPENSUBTITLES_KEY__: string | undefined;

/** The OpenSubtitles API key of this build ("" when it has none). */
export const BUILT_IN_OPENSUBTITLES_KEY: string =
  typeof __PORTALCAST_OPENSUBTITLES_KEY__ === "string" ? __PORTALCAST_OPENSUBTITLES_KEY__ : "";
