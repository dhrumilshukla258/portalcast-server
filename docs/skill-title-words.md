# Title words (per portal)

The word lists title cleaning uses, editable per IPTV profile in Admin → IPTV → Profiles → **Title words**. Code: `src/content/titleClean.ts` (the lists and the patterns built from them), `src/content/channelNames.ts` (the curated channel list), `src/content/titleWords.ts` (per-profile changes), `src/routes/admin/titleWords.ts` (API), webui `TitleWordsModal.tsx`.

## The lists

| List | Default | Used for |
| --- | --- | --- |
| Languages | 25 languages and their spellings (`LANGUAGE_ALIASES`: "hindi", "hin", "eng dub"…) | taken off titles; the version's audio label ("Eng Dub" -> Hindi on the default list) |
| Tags | 34 quality and other words (`QUALITY_TAGS`: "hd", "4k", "dual audio", "web series"…) | taken off titles; the quality label |
| Channel names | 183 names: the channel prefixes and the curated channel list with their spellings | taken off the front of series titles ("Hum TV : X"); the channel badge |

Rules that do not change with the lists: a short code ("ben", "mal", "pt") is a tag only where something marks it (a separator, a bracket, a real tag next to it, capitals at the end; never the first word); a one-word channel counts only before ":" or "|".

## A portal's changes

Stored per profile in `system_config` (`title_words_<profileId>`): languages `{ add: [{ spelling, language }], remove: [spelling] }`, tags and channels `{ add: [word], remove: [word] }`. Words are lowercase as people write them ("dual audio"); an added channel keeps its capitals (its badge). Checked on save: letters of any script, digits, spaces and `& + ' . ! -`, at most 60 characters and 300 words per list; added words are matched literally, never as patterns, and an emptied list matches nothing.

The active profile's changes are applied at start-up (before anything cleans a title), when the active profile changes (`config_profiles` hooks, 2 s later) and on save. When they differ from what was applied, the titles holding a changed word get their cleaned name and group recomputed in the background (`metaEnrichment.ts recleanForWords`, one run at a time); start-up only applies them. No changes: exactly the defaults (checked on a 133,629-name catalog: every cleaning function identical).

## API (admin only)

- `GET /api/admin/title-words/{profileId}`: `{ profileId, active, defaults: { languages, tags, channels }, edits }`
- `PUT /api/admin/title-words/{profileId}` with the edits: saved, applied when active, security-logged; 400 with a message for words that do not check out.
