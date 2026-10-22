# Cast tab (was People) and people's gender (2026-10-22)

The People tab in both apps: browse cast and crew with photos, filter by role, open a
person's page (their playable titles).

## `GET /api/v2/people?role=&page=`

- `role`: `all`, `actor`, `actress`, `director`, `creator`, `writer`; 60 per page.
- Answer: `{ data: PersonHit[], total, page, pageSize, counts: {role: n}, genderReady, ready }`.
  `PersonHit` is the people-search hit (`id`, `name`, `photo`, `knownFor`, `titles`).
- Who is listed: people with a photo and at least 3 major credits (lead cast, director,
  creator) in the catalog: 48,603 on the owner's data (2026-10-22).
- Order: All / Actors / Actresses by major credits (popularity); Directors / Creators /
  Writers by how many titles they directed / created / wrote (an actor who directed once is
  not near the top).
- Per viewer (owner: "ranking based on what the profile watched"): the people of the viewer's
  last 200 watched titles (directors, creators, first 10 billed) come first, most shared
  titles first, then everyone else as above (`peopleOfTitles`, ~20 ms; kept 10 minutes per
  viewer and profile, forgotten when their progress changes). On the owner's data: 51 titles,
  100 people first (Rasika Dugal, Ravi Kishan, Pankaj Tripathi... instead of Brahmanandam).
- Answered from memory (`content/peopleSearch.ts`): the people-search index plus, per
  person id, gender (1 byte) and directed / created / wrote counts (2 bytes each), ~2.5 MB.
  Role lists are made once per index and cached; a page is a slice (under 4 ms measured,
  0.4 ms for page 11). Genders and role counts are read when the index is built and after
  each gender fill run.

## Gender (`people.gender`)

Values: 1 female, 2 male, 3 non-binary, 0 TMDB has none, NULL not asked yet. Column added at
start-up (`db/index.ts` ensureColumns, a plain `ADD COLUMN`).

Sources: TMDB, where every stored person comes from (all but a handful of name-only NFO names
carry a TMDB person id).

- New credits: enrichment stores TMDB's gender with the credits (`content/tmdb.ts` peopleOf).
- Person pages: refreshed from TMDB person details (`content/people.ts` personDetails).
- People stored before: the `people-gender` job (`content/peopleGender.ts`) asks TMDB once
  per title for its credits (`/movie/{id}/credits`, `/tv/{id}/aggregate_credits` + the
  show's creators) and stores every gender in it, titles with most unknown people first;
  people TMDB does not mention are marked 0 so the title is not asked again. ~82k titles,
  about 6 a second, runs of at most 5 minutes every 10 minutes.
- Merge rule (one place, `GENDER_MERGE`): a known gender wins; 0 only replaces NULL.

TVmaze, OMDb and the IMDb ratings add nothing: TVmaze's cast is stored as text (no person
rows) and OMDb/IMDb carry no people. NFO files have no gender.

Tests: `test/people-gender.test.ts`.
