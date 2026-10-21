import { Channel } from "../models/Channel";
import { Genre, GenreType } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";
import { Op } from "sequelize";
import { gzipSync, gunzipSync } from "zlib";
import { logger } from "@/infra/logger";

export async function writeJSON(filename: string, data: any) {
  try {
    if (filename === "channel-groups.json") {
      await writeGenres(data, "channel");
    } else if (filename === "channels.json") {
      await writeChannels(data);
    } else if (filename === "movie-groups.json") {
      await writeGenres(data, "movie");
    } else if (filename === "series-groups.json") {
      await writeGenres(data, "series");
    } else if (filename === "epg-cache.json") {
      if (Array.isArray(data) && data.length > 0) {
        await writeEpgCache(data[0]);
      }
    }
  } catch (error) {
    logger.error({ err: error }, `Error writing to database (${filename})`);
    throw error;
  }
}

export function readJSON<T>(filename: string): T[] {
  throw new Error(
    "readJSON is deprecated. Use readChannels, readGenres, or readEpgCache instead.",
  );
}

export async function writeChannels(
  channels: any[],
  profileId?: number,
): Promise<void> {
  try {
    if (profileId !== undefined) {
      await Channel.destroy({ where: { profileId } });
    }

    const prefix = profileId !== undefined ? `${profileId}_` : ``;
    const channelsToInsert = channels.map((channel) => ({
      ...channel,
      id: `${prefix}${channel.id}`,
      profileId: profileId !== undefined ? profileId : null,
    }));

    await Channel.bulkCreate(channelsToInsert, {
      updateOnDuplicate: [
        "name",
        "cmd",
        "logo",
        "tv_genre_id",
        "censored",
        "number",
        "profileId",
      ],
    });
  } catch (error) {
    logger.error({ err: error }, "Error writing channels to database");
    throw error;
  }
}

export async function readChannels(profileId?: number): Promise<any[]> {
  try {
    const channels = await Channel.findAll({
      where: profileId !== undefined ? { profileId } : {},
      raw: true,
    });
    const prefix = profileId !== undefined ? `${profileId}_` : ``;
    return channels.map(c => ({
      ...c,
      id: c.id.replace(/^\d+_/, "")
    }));
  } catch (error) {
    logger.error({ err: error }, "Error reading channels from database");
    return [];
  }
}

export async function writeGenres(
  genres: any[],
  type: GenreType,
  profileId?: number,
): Promise<void> {
  try {
    if (profileId !== undefined) {
      await Genre.destroy({
        where: { type, profileId },
      });
    } else {
      await Genre.destroy({ where: { type } });
    }

    const prefix = profileId !== undefined ? `${profileId}_` : ``;
    const genresToInsert = genres.map((genre) => ({
      ...genre,
      id: `${prefix}${type}_${genre.id}`,
      type,
      profileId: profileId !== undefined ? profileId : null,
    }));

    await Genre.bulkCreate(genresToInsert, {
      updateOnDuplicate: [
        "title",
        "number",
        "alias",
        "censored",
        "type",
        "profileId",
      ],
    });
  } catch (error) {
    logger.error({ err: error }, `Error writing ${type} genres to database`);
    throw error;
  }
}

export async function upsertGenres(
  genres: any[],
  type: GenreType,
  profileId?: number,
): Promise<void> {
  const prefix = profileId !== undefined ? `${profileId}_` : ``;
  const rows = genres.map((genre) => ({
    ...genre,
    id: `${prefix}${type}_${genre.id}`,
    type,
    profileId: profileId !== undefined ? profileId : null,
  }));
  await Genre.bulkCreate(rows, {
    updateOnDuplicate: ["title", "number", "alias", "censored", "type", "profileId"],
  });
}

export async function upsertGenre(genre: any, type: GenreType): Promise<void> {
  const profileId = genre.profileId ?? null;
  const prefix = profileId != null ? `${profileId}_` : ``;
  await Genre.upsert({
    id: `${prefix}${type}_${genre.id}`,
    title: genre.title,
    number: genre.number ?? null,
    alias: genre.alias ?? null,
    censored: genre.censored ?? 0,
    type,
    profileId,
  });
}

export async function deleteGenre(genre: any, type: GenreType): Promise<void> {
  const profileId = genre.profileId ?? null;
  const prefix = profileId != null ? `${profileId}_` : ``;
  await Genre.destroy({ where: { id: `${prefix}${type}_${genre.id}` } });
}

// Category lists are read on most catalog requests and change only when the portal's
// categories are refreshed: kept in memory, dropped by any write to the genres table (hooks).
// `genresGen` counts writes, so a read that started before a write never stores its old rows.
const genresMemo = new Map<string, any[]>();
let genresGen = 0;
for (const hook of ["afterCreate", "afterBulkCreate", "afterUpdate", "afterBulkUpdate", "afterSave", "afterDestroy", "afterBulkDestroy", "afterUpsert"] as const) {
  Genre.addHook(hook, `genres-memo-${hook}`, () => { genresGen++; genresMemo.clear(); });
}

export async function readGenres(
  type: GenreType,
  profileId?: number,
): Promise<any[]> {
  try {
    const memoKey = `${type}|${profileId ?? "*"}`;
    const memo = genresMemo.get(memoKey);
    // Copies: callers may change what they get.
    if (memo) return memo.map((g) => ({ ...g }));
    const gen = genresGen;
    const genres = await Genre.findAll({
      where: {
        type,
        ...(profileId !== undefined ? { profileId } : {}),
      },
      raw: true,
    });

    const rows = genres.map((g) => ({
      ...g,
      id: g.id.replace(new RegExp(`^\\d+_${type}_`), "").replace(new RegExp(`^${type}_`), ""),
    }));
    if (gen === genresGen) genresMemo.set(memoKey, rows);
    return rows.map((g) => ({ ...g }));
  } catch (error) {
    logger.error({ err: error }, `Error reading ${type} genres from database`);
    return [];
  }
}

export async function writeEpgCache(
  cacheData: { timestamp: Date; data: any },
  profileId?: number,
): Promise<void> {
  try {
    // Always destroy old rows before inserting to prevent accumulation.
    // profileId=undefined means "no active profile" — destroy the null-profileId row.
    const destroyWhere = profileId !== undefined ? { profileId } : { profileId: null };
    await EpgCache.destroy({ where: destroyWhere });

    const compressed = gzipSync(JSON.stringify(cacheData.data)).toString("base64");
    await EpgCache.create({
      timestamp: cacheData.timestamp,
      data: compressed,
      profileId: profileId !== undefined ? profileId : null,
    });
  } catch (error) {
    throw error;
  }
}

export async function readEpgCache(profileId?: number): Promise<any | null> {
  try {
    const cache = await EpgCache.findOne({
      where: profileId !== undefined ? { profileId } : {},
      order: [["timestamp", "DESC"]],
    });

    if (!cache) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(gunzipSync(Buffer.from(cache.data, "base64")).toString());
    } catch {
      parsed = JSON.parse(cache.data);
    }
    return { timestamp: cache.timestamp, data: parsed };
  } catch (error) {
    logger.error({ err: error }, "Error reading EPG cache from database");
    return null;
  }
}
