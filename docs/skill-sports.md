# Sports schedule (plan Phase 6.7)

The Sports tab in both apps: upcoming games of the leagues the admin chose, and the channel
the guide shows each one on.

## Source

[sporting-events.org](https://sporting-events.org/data/) JSON files, one per league:
`https://sporting-events.org/data/{slug}.json`. No key, no sign-up; free for personal and
commercial use with a link to the source, which both apps show ("Schedule: sporting-events.org").
Fields used per event: `date_utc`, `time_utc` ("00:00" or empty means no time yet), `fixture`,
`home_team`, `away_team`, `city`, `country`, `broadcast`, `status`, `url`.

Only the server calls the source; nothing about the server or its users is sent (a plain GET).

## Server

- `src/content/sports.ts`: fetch, parse (defensive: sizes and lengths capped, links only to the
  source site), keep games from a day ago to 30 days ahead in memory (no database table).
- Setting `sportsLeagues` (Admin, group Sports): the leagues for viewers who have not chosen,
  at most 20. Default: cricket, ipl, tennis, premier-league, champions-league, la-liga,
  formula-1, nba, nfl.
- Fetching starts with the first `GET /api/v2/sports`, then the `sports` job refreshes hourly
  while Sports was opened in the last 3 days. Files are fetched one at a time, 500 ms apart; a
  failed file keeps that league's previous games.
- `GET /api/v2/sports?days=30` (1–45; any signed-in user): `{ source, updatedAt, loading, guide,
  leagues[], games[] }`, each game with `live` and `channels: [{ channelId, programme }]`. A
  month by default: some sports (cricket) have a game every few weeks in the source.
- Each viewer chooses their own leagues (owner, 2026-10-22): `GET /api/v2/sports/leagues` lists
  every league the source has (`CATALOGUE`, ~80, with a name and sport) and the viewer's
  choice; the apps save it in the viewer's preferences (`sportsLeagues`, known slugs only, at
  most 20). Without a choice, the admin's `sportsLeagues` setting applies. A league someone
  chose is fetched on demand and kept current hourly while asked for (3 days).
- Coverage is the source's: on 2026-10-22 its cricket file had 8 events (The Ashes, Big Bash,
  from 26 November); IPL is empty out of season.

## Channel match (strict)

The owner ruled out loose matching ("buggy and not good"). A channel is listed only when:

- the guide has a programme on it running 15 minutes after kick-off (no time: starting that UTC day),
- whose name holds both team names as whole words (accents and punctuation ignored, "FC"/"AFC"
  dropped), or for an event without teams its whole name ("United States Grand Prix"), and
- which is not highlights, a replay, a preview and the like (`NOT_LIVE`, includes "HL").

Teams under 3 letters and one-word events are never matched. Checked against the owner's guide
(2026-10-22, 39,616 programme names): Champions League, La Liga and NBA games matched names such
as "Live-Liverpool vs. Villarreal CF-UEFA Champions League" and "Boston Celtics at Detroit
Pistons"; "UCL HL 26/27: Lille v Galatasaray" led to adding "HL". The match is computed once per
guide, schedule version and hour, and logged (`[sports] guide match: …`).

Answers carry channel ids only; the apps take names and logos from their own channel list, so
hidden and renamed channels follow the admin's overrides. No match: the apps show the
broadcasters from the schedule and "Find channel" (Search on Live TV for the first one).

Tests: `test/sports.test.ts`.
