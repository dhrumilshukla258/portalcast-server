// The "All Movies" / "All Series" catalog for the routes: the snapshot view (catalog/views.ts)
// when the catalog snapshot is on, content/catalogUnion.ts when it is off. The one place that
// chooses; routes never call either directly. With the snapshot on, the union is never built
// (it would hold the ~186 MB of parsed lists the snapshot replaces): requests wait for the
// snapshot instead (loaded from its file at start in about half a second).

import { setting } from "@/config/settings";
import { searchCatalog } from "@/content/searchIndex";
import { localSearch } from "@/content/library/catalog";
import { getCatalogUnion, catalogItem, applyOverridesToMatches } from "@/content/catalogUnion";
import { allView, type CatalogType, type PagedList } from "./views";
import { catalogReady } from "./store";

const fromArray = (items: any[]): PagedList => ({ length: items.length, page: (offset, count) => items.slice(offset, offset + count) });

/** Local-library matches first, then the catalog's (as the routes listed them). */
function concat(first: any[], rest: PagedList): PagedList {
  return {
    length: first.length + rest.length,
    page: (offset, count) => {
      const head = first.slice(offset, offset + count);
      return head.length === count ? head : [...head, ...rest.page(Math.max(0, offset - first.length), count - head.length)];
    },
  };
}

/** The snapshot view, or undefined when the snapshot is off or could not be built (then the
 *  union answers, as before). Null: the catalog is empty. */
async function view(type: CatalogType, profileId: number | undefined) {
  if (!setting<boolean>("catalogSnapshot") || !(await catalogReady())) return undefined;
  return allView(type, profileId);
}

/**
 * The "*" list a page is cut from: browse order (overrides applied), or with `search` the
 * local-library matches then the ranked catalog matches. Null when the catalog is empty.
 */
export async function allPage(type: CatalogType, profileId: number | undefined, search?: string): Promise<PagedList | null> {
  const v = await view(type, profileId);
  if (v !== undefined) {
    if (!v) return null;
    if (!search) return v.browseList();
    return concat(await localSearch(type, String(search)), await v.search(String(search)));
  }
  const union = await getCatalogUnion(type, profileId);
  if (!union) return null;
  if (!search) return fromArray(union.browse);
  const local = await localSearch(type, String(search));
  // filterBySearch (routes/stalkerV2/shared.ts) over the union, as the routes called it.
  const matches = String(search).trim() ? searchCatalog(`${type}:*`, union.raw, String(search)) : union.raw;
  return fromArray([...local, ...(await applyOverridesToMatches(type, matches))]);
}

/** The category a title is listed in (first in genre order), for opening it from Discover. */
export async function allCategoryOf(type: CatalogType, id: string | number, profileId: number | undefined): Promise<string | undefined> {
  const v = await view(type, profileId);
  if (v !== undefined) return v?.categoryOf(id);
  return (await getCatalogUnion(type, profileId))?.catOf.get(String(id));
}

/** One portal item of the "*" catalog by id, or null. */
export async function allItem(type: CatalogType, id: string | number, profileId: number | undefined): Promise<any | null> {
  const v = await view(type, profileId);
  if (v !== undefined) return v?.item(id) ?? null;
  return catalogItem(type, id, profileId);
}
