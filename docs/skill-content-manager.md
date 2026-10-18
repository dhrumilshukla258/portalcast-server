# Content Manager — Skill Reference

The Content Manager is the admin UI and API for customizing how content appears to clients — without touching the portal or cache. Access at `http://your-server:3000/contentmanager` (password: `ADMIN_PASSWORD`). The page response carries `X-Frame-Options: SAMEORIGIN` (clickjacking guard, added alongside the same header on the root SPA route — see [[skill-frontend-hosting]]).

Related: [[skill-database]], [[skill-xtream-provider]], [[skill-admin-dashboard]], [[skill-stream-tokens]]

Note: this doc covers **manual admin overrides** (rename/hide/move/reorder). For **automatic** removal of content the portal itself no longer has (no admin action involved), see [[skill-content-lifecycle]] instead.

---

## What It Does

All changes are stored in `GenreOverride` and `ContentOverride` tables. The override layer is applied transparently to every `/api/v2` browse response — the portal cache is never modified.

Three tabs: **Live**, **VOD**, **Series**.

---

## Category Operations

| Action | Effect |
|--------|--------|
| Rename | Override display name (`GenreOverride.display_name`); original preserved in DB |
| Hide | Set `GenreOverride.hidden = true` — excluded from all API responses |
| Reorder | Drag-and-drop or A-Z sort; persists `GenreOverride.sort_order` |
| Reset order | Clears `sort_order` for all genres of a type; restores portal order |
| Create virtual | Adds a new `GenreOverride` with `virtual = true`, `id` prefixed `vcat_` (VOD/Series only) |
| Delete virtual | Removes virtual category; all items moved into it are restored to `original_category_id` |

---

## Item Operations

| Action | Effect |
|--------|--------|
| Rename | `ContentOverride.display_name` |
| Hide | `ContentOverride.hidden = true` |
| Move | Sets `target_category_id` (saves `original_category_id` for restore); moves item in all API responses |
| Reorder | `ContentOverride.sort_order` within category |
| Multi-select | Shift+click for range selection; same operation applied to all selected items |

---

## Move Semantics

When an item is moved:
- `target_category_id` is set (can be a `vcat_*` virtual ID)
- `original_category_id` is saved

When fetching a category:
- Items with `target_category_id = THIS` are appended (moved in)
- Items with `target_category_id ≠ THIS` are excluded (moved out)
- Sort order is applied after merge

Deleting a virtual category: all `ContentOverride` records pointing to it have `target_category_id` cleared, restoring items to `original_category_id`.

---

## Virtual Categories

- IDs prefixed `vcat_` (e.g. `vcat_1234`)
- A virtual ID never reaches the portal — `/api/admin/items` and the `/api/v2` browse routes resolve `vcat_*` groups from `ContentOverride` + `XtreamCache` directly (no portal call)
- Items from any regular category can be moved into virtual categories freely

---

## Override Application (how it works in code)

`src/content/overrides.ts` exports:

| Function | Used by |
|----------|---------|
| `applyGenreOverrides(genres, type)` | `/api/v2` group/category lists (channels, movies, series) |
| `applyChannelOverrides(channels)` | `/api/v2/channels` |
| `applyPortalItemOverrides(items, type, categoryId, getCached)` | `/api/v2/movies`, `/api/v2/series` (hide, rename, move-in/move-out, sort) |
| `getHiddenGenreIds(type)` | Used to filter search results |

The Xtream-shaped variants (`applyXtreamCatOverrides`, `applyVodOverrides`, `applySeriesOverrides`, `applyXtreamChannelOverrides`) were deleted with the player emulation layer on 2026-10-18, along with the Jellyfin `.strm` generator that used to live next to this feature — see the note at the top of [[skill-xtream-provider]].

---

## Admin Page Template — `escId()` (`src/routes/contentmanager/adminPage.template.ts`)

Category/item IDs come from the upstream portal, not from us, and get interpolated into `renderCategories`/`renderItems` twice per row: once as a `data-id="..."` HTML attribute, once inside single-quoted `onclick="fn('...')"` JS-string literals. The pre-existing `esc()` helper only HTML-escapes, which doesn't stop a `'` or `\` in an ID from breaking out of the JS-string context. An uncommitted hardening pass added `escId()` — escapes backslash/quote/newlines for the JS-string context *and* HTML-entity-escapes for the attribute context in one pass — and swapped every `${cat.id}`/`${item.id}` call-site interpolation in those two render functions over to it (`esc()` is unchanged, still used for display text).

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/genres?type=` | List categories with override state |
| `POST` | `/api/admin/genres/{type}` | Create virtual category |
| `PUT` | `/api/admin/genres/{type}/{id}` | Update category (rename/hide/sort) |
| `PUT` | `/api/admin/genres/{type}/reorder` | Bulk-set category sort order |
| `DELETE` | `/api/admin/genres/{type}/{id}` | Remove category override |
| `DELETE` | `/api/admin/genres/{type}/order` | Clear all custom sort order |
| `GET` | `/api/admin/items?type=&category_id=` | List items with override state |
| `PUT` | `/api/admin/items/{type}/{id}` | Update item (rename/hide/move) |
| `PUT` | `/api/admin/items/{type}/{category_id}/reorder` | Bulk-set item sort order |
| `DELETE` | `/api/admin/items/{type}/{id}` | Remove item override |

`type` param values: `channel`, `movie`, `series`.

---

## Key Files

- `src/content/overrides.ts` — all override application functions
- `src/models/GenreOverride.ts`, `src/models/ContentOverride.ts`
- `src/routes/contentmanager/` — `page.ts` (the standalone HTML page), `genres.ts`, `items.ts`, `metaEnrichment.ts`, `shared.ts`