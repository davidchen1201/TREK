import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { DATA_ROOT } from '../storage/storage-paths';

const TILE_HOST = 'https://tile.openstreetmap.org';
const CACHE_ROOT = path.join(DATA_ROOT, 'map-tiles');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 80 * 1024 * 1024;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const USER_AGENT = 'TREK/4.2 (+https://github.com/davidchen1201/TREK)';

export interface TileCoordinates {
  z: number;
  x: number;
  y: number;
}

/** Strictly parse a Web Mercator tile coordinate; never coerce route input. */
export function parseTileCoordinates(z: string, x: string, y: string): TileCoordinates | null {
  const parse = (value: string): number | null => {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const zoom = parse(z);
  const tileX = parse(x);
  const tileY = parse(y);
  if (zoom === null || tileX === null || tileY === null || zoom > 18) return null;
  const edge = 2 ** zoom;
  if (tileX >= edge || tileY >= edge) return null;
  return { z: zoom, x: tileX, y: tileY };
}

/**
 * OSM requires a web Referer, but a shared-page path can itself be a bearer
 * credential. Keep the identifying origin while never disclosing that path,
 * query, fragment, or any URL userinfo to the upstream tile host.
 */
export function mapTileReferer(referer: string | undefined): string | undefined {
  if (!referer || referer.length > 2048) return undefined;
  try {
    const parsed = new URL(referer);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return `${parsed.origin}/`;
  } catch {
    return undefined;
  }
}

/**
 * A deliberately small cache for tiles users are actively viewing. The only
 * outbound target is OSM's documented standard raster host; there is no URL
 * input here, no prefetching, and cache misses are deduplicated per tile.
 */
@Injectable()
export class MapTileService {
  // Mutable only so focused tests can use an isolated temporary directory.
  private cacheRoot = CACHE_ROOT;
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  async get(coords: TileCoordinates, referer?: string): Promise<Buffer> {
    const key = `${coords.z}/${coords.x}/${coords.y}.png`;
    const cached = await this.readCached(key);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.fetchAndCache(key, coords, referer);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private cachePath(key: string): string {
    // key is constructed from numbers above, never a caller-supplied path.
    return path.join(this.cacheRoot, key);
  }

  private async readCached(key: string): Promise<Buffer | null> {
    const file = this.cachePath(key);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
      const bytes = await fs.readFile(file);
      // mtime is the fixed upstream-fetch freshness timestamp. atime alone is
      // our best-effort LRU signal, so a frequently viewed tile still expires
      // after seven days and is conditionally refreshed by normal demand.
      await fs.utimes(file, new Date(), stat.mtime).catch(() => undefined);
      return bytes;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async fetchAndCache(key: string, coords: TileCoordinates, referer?: string): Promise<Buffer> {
    const headers: Record<string, string> = {
      Accept: 'image/png',
      'User-Agent': USER_AGENT,
    };
    const safeReferer = mapTileReferer(referer);
    if (safeReferer) headers.Referer = safeReferer;

    const response = await fetch(`${TILE_HOST}/${coords.z}/${coords.x}/${coords.y}.png`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OSM tile request failed with ${response.status}`);
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'image/png') {
      throw new Error('OSM tile response was not image/png');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_TILE_BYTES) {
      throw new Error('OSM tile response exceeds the byte limit');
    }
    const bytes = await this.readBoundedBody(response);
    await this.writeCached(key, bytes);
    return bytes;
  }

  private async readBoundedBody(response: Response): Promise<Buffer> {
    if (!response.body) throw new Error('OSM tile response had no body');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TILE_BYTES) {
          await reader.cancel();
          throw new Error('OSM tile response exceeds the byte limit');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }

  private async writeCached(key: string, bytes: Buffer): Promise<void> {
    const destination = this.cachePath(key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
    await this.pruneCache();
  }

  /** Keep the actual on-disk cache bounded; oldest accesses leave first. */
  private async pruneCache(): Promise<void> {
    const files: Array<{ file: string; size: number; atimeMs: number }> = [];
    const visit = async (dir: string): Promise<void> => {
      let entries: Dirent<string>[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (err: any) {
        if (err?.code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.png')) {
          const stat = await fs.stat(file);
          files.push({ file, size: stat.size, atimeMs: stat.atimeMs });
        }
      }
    };
    await visit(this.cacheRoot);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.atimeMs - b.atimeMs)) {
      if (total <= CACHE_MAX_BYTES) break;
      await fs.unlink(file.file).catch(() => undefined);
      total -= file.size;
    }
  }
}
