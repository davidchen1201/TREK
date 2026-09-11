import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapTileService, mapTileReferer, parseTileCoordinates } from '../../../src/nest/share/map-tile.service';

describe('MapTileService', () => {
  const temporaryDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function service() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trek-map-tiles-'));
    temporaryDirs.push(dir);
    const result = new MapTileService();
    (result as unknown as { cacheRoot: string }).cacheRoot = dir;
    return result;
  }

  it('strictly accepts only in-range numeric Web Mercator coordinates', () => {
    expect(parseTileCoordinates('0', '0', '0')).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTileCoordinates('18', '262143', '262143')).toEqual({ z: 18, x: 262143, y: 262143 });
    const invalid: Array<[string, string, string]> = [['19', '0', '0'], ['2', '4', '0'], ['2', '0', '4'], ['2', '-1', '0'], ['2', '1.5', '0'], ['2', '01', '0']];
    for (const parts of invalid) {
      expect(parseTileCoordinates(...parts)).toBeNull();
    }
  });

  it('keeps only an http(s) referring origin, never the bearer-token path', () => {
    expect(mapTileReferer('https://trek.example/shared/edit-capable-token?x=1#map')).toBe('https://trek.example/');
    expect(mapTileReferer('http://trek.example:8080/a')).toBe('http://trek.example:8080/');
    expect(mapTileReferer('not a URL')).toBeUndefined();
    expect(mapTileReferer('file:///shared/token')).toBeUndefined();
  });

  it('uses only the fixed OSM URL, forwards the page Referer, and caches a demand hit for seven days', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from('png-bytes'), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '9' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tiles = await service();

    await expect(tiles.get({ z: 3, x: 4, y: 2 }, 'https://trek.example/shared/token')).resolves.toEqual(Buffer.from('png-bytes'));
    await expect(tiles.get({ z: 3, x: 4, y: 2 }, 'https://trek.example/shared/token')).resolves.toEqual(Buffer.from('png-bytes'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://tile.openstreetmap.org/3/4/2.png',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Referer: 'https://trek.example/',
          'User-Agent': 'TREK/4.2 (+https://github.com/davidchen1201/TREK)',
        }),
      }),
    );
  });

  it('uses fixed fetch mtime for the seven-day freshness limit while retaining atime for LRU', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(Buffer.from('first'), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '5' } }))
      .mockResolvedValueOnce(new Response(Buffer.from('fresh'), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '5' } }));
    vi.stubGlobal('fetch', fetchMock);
    const tiles = await service();
    const coords = { z: 3, x: 4, y: 2 };
    await expect(tiles.get(coords)).resolves.toEqual(Buffer.from('first'));

    const file = path.join((tiles as unknown as { cacheRoot: string }).cacheRoot, '3/4/2.png');
    const staleMtime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 1_000);
    await fs.utimes(file, new Date(), staleMtime);
    await expect(tiles.get(coords)).resolves.toEqual(Buffer.from('fresh'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses non-PNG and oversized upstream bodies before caching them', async () => {
    const tiles = await service();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(tiles.get({ z: 1, x: 0, y: 0 })).rejects.toThrow('not image/png');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024 + 1) },
    })));
    await expect(tiles.get({ z: 1, x: 1, y: 0 })).rejects.toThrow('byte limit');
  });
});
