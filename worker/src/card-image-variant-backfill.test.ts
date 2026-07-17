import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

import type { CardImageVariant } from './card-image-variant';
import {
  locateCardVariantTarget,
  runCardImageVariantBackfill,
} from './card-image-variant-backfill';

const variants: CardImageVariant[] = [
  { url: '/r/x/card/one-w400.webp', width: 400, height: 250, format: 'webp', bytes: 20_000 },
];

type BackfillRow = {
  id: string;
  source_type: string;
  media: string | null;
  extra: string | null;
};

type Call = { sql: string; bound: unknown[] };

function fakeBackfillEnv(
  rows: BackfillRow[],
  options: {
    remaining?: number;
    writeChanges?: number;
    metadataByKey?: Record<string, Record<string, string>>;
  } = {},
): {
  env: Parameters<typeof runCardImageVariantBackfill>[0];
  calls: Call[];
} {
  const calls: Call[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const call: Call = { sql, bound: [] };
        calls.push(call);
        const statement = {
          bind: (...bound: unknown[]) => {
            call.bound = bound;
            return statement;
          },
          all: async () => ({ results: rows }),
          first: async () => ({ n: options.remaining ?? rows.length }),
          run: async () => ({
            success: true,
            meta: { changes: options.writeChanges ?? 1 },
          }),
        };
        return statement;
      },
    },
    READMES: {
      head: async (key: string) => {
        const customMetadata = options.metadataByKey?.[key];
        return customMetadata ? { customMetadata } : null;
      },
    },
  } as unknown as Parameters<typeof runCardImageVariantBackfill>[0];
  return { env, calls };
}

describe('card variant backfill target selection', () => {
  test('X mutates only the primary still image and leaves the original for lightbox', () => {
    const media: Array<{
      type: string;
      url: string;
      width?: number;
      height?: number;
      card_variants?: CardImageVariant[];
    }> = [
      { type: 'image', url: '/r/x/original.jpg', width: 1200, height: 750 },
      { type: 'image', url: '/r/x/secondary.jpg' },
    ];
    const extra: Record<string, unknown> = {};
    const target = locateCardVariantTarget('x_list', media, extra);

    expect(target?.url).toBe('/r/x/original.jpg');
    target?.apply(variants);
    expect(media[0].url).toBe('/r/x/original.jpg');
    expect(media[0].card_variants).toEqual(variants);
    expect(media[1]).not.toHaveProperty('card_variants');
  });

  test('X retweets optimize the flipped retweet body and video bytes never enter transform', () => {
    const media = [{ type: 'video', url: '/r/x/body.mp4', poster: '/r/x/body.jpg' }];
    const retweetMedia: Array<{
      type: string;
      url: string;
      poster: string;
      poster_variants?: CardImageVariant[];
    }> = [{ type: 'video', url: '/r/x/retweet.mp4', poster: '/r/x/retweet.jpg' }];
    const extra = {
      is_retweet: true,
      retweet_of: {
        media: retweetMedia,
      },
    };
    const target = locateCardVariantTarget('x_list', media, extra);

    expect(target?.url).toBe('/r/x/retweet.jpg');
    expect(target?.mediaKind).toBe('image');
    target?.apply(variants);
    expect(retweetMedia[0].poster_variants).toEqual(variants);
    expect(extra.retweet_of.media[0].url).toBe('/r/x/retweet.mp4');
  });

  test('scalar covers bind variants to the exact current cover', () => {
    const extra: Record<string, unknown> = {
      cover_image: '/r/blog/current.jpg',
      body_markdown: 'full detail remains',
    };
    const target = locateCardVariantTarget('blog', [], extra);

    target?.apply(variants);
    expect(extra.cover_image).toBe('/r/blog/current.jpg');
    expect(extra.cover_image_variants).toEqual(variants);
    expect(extra.cover_variant_source).toBe('/r/blog/current.jpg');
    expect(extra.body_markdown).toBe('full detail remains');
  });

  test('scalar cover changes re-enter without stale variants and failed attempts terminate on the current cover', async () => {
    const staleVariants: CardImageVariant[] = [{
      url: '/r/blog/card/stale-w400.webp',
      width: 400,
      format: 'webp',
      bytes: 123,
    }];
    const extra: Record<string, unknown> = {
      cover_image: 'https://cdn.example.com/current.jpg',
      cover_image_variants: staleVariants,
      cover_variant_source: 'https://cdn.example.com/old.jpg',
      card_variant_version: 1,
    };
    const target = locateCardVariantTarget('blog', [], extra);
    expect(target?.existingVariants).toBeUndefined();

    const { env, calls } = fakeBackfillEnv([{
      id: 'blog:mismatch',
      source_type: 'blog',
      media: '[]',
      extra: JSON.stringify(extra),
    }]);
    const generatedSources: Array<Record<string, unknown>> = [];
    const result = await runCardImageVariantBackfill(
      env,
      { dryRun: false, limit: 1 },
      {
        generate: async (_bucket, source) => {
          generatedSources.push(source);
          return [];
        },
      },
    );

    expect(result.transform_failed).toBe(1);
    expect(generatedSources).toHaveLength(1);
    expect(generatedSources[0].sourceUrl).toBe('https://cdn.example.com/current.jpg');
    const select = calls[0].sql;
    expect(select).toContain('cover_variant_source');
    expect(select).toContain('cover_image');
    expect(select).toContain('length(trim');
    const update = calls.find((call) => /UPDATE items/.test(call.sql));
    const writtenExtra = JSON.parse(String(update?.bound[1]));
    expect(writtenExtra.cover_variant_source).toBe('https://cdn.example.com/current.jpg');
    expect(writtenExtra).not.toHaveProperty('cover_image_variants');
    expect(writtenExtra.card_variant_status).toBe('transform_failed');

    const changedAgain = {
      ...writtenExtra,
      cover_image: 'https://cdn.example.com/newer.jpg',
    };
    expect(locateCardVariantTarget('blog', [], changedAgain)?.existingVariants).toBeUndefined();
  });

  test('backfill passes the live migration User-Agent for every source prefix', async () => {
    const rows: BackfillRow[] = [
      {
        id: 'x:1', source_type: 'x_list',
        media: JSON.stringify([{ type: 'image', url: 'https://pbs.twimg.com/a.jpg' }]), extra: '{}',
      },
      {
        id: 'ph:1', source_type: 'product_hunt',
        media: JSON.stringify([{ type: 'image', role: 'gallery', url: 'https://ph-files.example/a.jpg' }]), extra: '{}',
      },
      {
        id: 'hf:1', source_type: 'hf_paper',
        media: JSON.stringify([{ type: 'image', url: 'https://cdn.huggingface.co/a.jpg' }]), extra: '{}',
      },
      {
        id: 'gh:1', source_type: 'github', media: '[]',
        extra: JSON.stringify({ cover_url: 'https://raw.githubusercontent.com/a/b/main/a.jpg' }),
      },
      {
        id: 'blog:1', source_type: 'blog', media: '[]',
        extra: JSON.stringify({ cover_image: 'https://news.example/a.jpg' }),
      },
      {
        id: 'podcast:1', source_type: 'podcast', media: '[]',
        extra: JSON.stringify({ cover_image: 'https://podcast.example/a.jpg' }),
      },
    ];
    const { env } = fakeBackfillEnv(rows, { remaining: 0 });
    const headers = new Map<string, string | undefined>();
    await runCardImageVariantBackfill(
      env,
      { dryRun: false, limit: rows.length },
      {
        generate: async (_bucket, source) => {
          headers.set(source.sourcePrefix, source.sourceRequestHeaders?.['User-Agent']);
          return variants;
        },
      },
    );

    const browserUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    expect(Object.fromEntries(headers)).toEqual({
      x: browserUa,
      ph: 'Mozilla/5.0 (compatible; ai-feeds-r2-migrate/1.0)',
      hf: 'Mozilla/5.0 (compatible; aifeeds-r2-migrate/1.0)',
      gh: 'ai-feeds-scraper/1.0 (+https://ai-feeds.com)',
      blog: browserUa,
      podcast: browserUa,
    });
  });

  test('a full final write batch completes without exposing a stale resume cursor', async () => {
    const { env } = fakeBackfillEnv([{
      id: 'blog:final',
      source_type: 'blog',
      media: '[]',
      extra: JSON.stringify({ cover_image: 'https://news.example/final.jpg' }),
    }], { remaining: 0 });

    const result = await runCardImageVariantBackfill(
      env,
      { dryRun: false, limit: 1 },
      { generate: async () => variants },
    );

    expect(result.complete).toBe(true);
    expect(result.next_cursor).toBeNull();
  });

  test('HF legacy figure falls back to extra.figure_image.raw_url when R2 metadata is absent', async () => {
    const { env } = fakeBackfillEnv([{
      id: 'hf:figure',
      source_type: 'hf_paper',
      media: JSON.stringify([{
        type: 'image',
        role: 'figure',
        url: '/r/hf/legacy-figure.png',
        width: 1200,
        height: 800,
      }]),
      extra: JSON.stringify({
        figure_image: {
          raw_url: 'https://arxiv.org/html/2607.00001/x1.png',
          r2_url: '/r/hf/legacy-figure.png',
        },
      }),
    }], { remaining: 0 });
    const sources: Array<Record<string, unknown>> = [];
    const result = await runCardImageVariantBackfill(
      env,
      { dryRun: false, limit: 1 },
      {
        generate: async (_bucket, source) => {
          sources.push(source);
          return variants;
        },
      },
    );

    expect(result).toMatchObject({ updated: 1, source_unavailable: 0, transform_failed: 0 });
    expect(sources[0]).toMatchObject({
      sourceUrl: 'https://arxiv.org/html/2607.00001/x1.png',
      sourcePrefix: 'hf',
      sourceRequestHeaders: {
        'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-r2-migrate/1.0)',
      },
    });
  });

  test('malformed row JSON increments errors and does not abort the rest of the batch', async () => {
    const { env, calls } = fakeBackfillEnv([
      {
        id: 'blog:broken', source_type: 'blog', media: '[]', extra: '{bad-json',
      },
      {
        id: 'blog:valid', source_type: 'blog', media: '[]',
        extra: JSON.stringify({ cover_image: 'https://news.example/valid.jpg' }),
      },
    ]);

    const result = await runCardImageVariantBackfill(env, { dryRun: true, limit: 2 });

    expect(result).toMatchObject({ picked: 2, errors: 1, would_update: 1, resolvable: 1 });
    expect(calls[0].sql).toContain('json_valid');
    expect(result.complete).toBe(false);
  });

  test('Product Hunt skips logos and direct video bodies', () => {
    const media = [
      { type: 'image', role: 'logo', url: '/r/ph/logo.png' },
      { type: 'video', url: '/r/ph/demo.mp4' },
      { type: 'image', role: 'gallery', url: '/r/ph/gallery.jpg' },
    ];
    const target = locateCardVariantTarget('product_hunt', media, {});
    expect(target?.url).toBe('/r/ph/gallery.jpg');
  });

  test('Product Hunt recovers an existing R2 GIF source and records a no-fallback preview failure', async () => {
    const original = '/r/ph/large-launch.gif';
    const { env, calls } = fakeBackfillEnv([{
      id: 'product_hunt:animated',
      source_type: 'product_hunt',
      media: JSON.stringify([{
        type: 'image',
        role: 'gallery',
        url: original,
      }]),
      extra: JSON.stringify({ card_variant_version: 1 }),
    }], {
      remaining: 0,
      metadataByKey: {
        'ph/large-launch.gif': {
          'src-url': 'https://ph-files.example/large-launch.gif',
        },
      },
    });
    const generatedSources: Array<Record<string, unknown>> = [];

    const result = await runCardImageVariantBackfill(
      env,
      { dryRun: false, limit: 1 },
      {
        generate: async (_bucket, source) => {
          generatedSources.push(source);
          return [];
        },
      },
    );

    expect(result).toMatchObject({ updated: 1, transform_failed: 1 });
    expect(generatedSources[0]).toMatchObject({
      sourceUrl: 'https://ph-files.example/large-launch.gif',
      sourcePrefix: 'ph',
    });
    const update = calls.find((call) => /UPDATE items/.test(call.sql));
    const writtenMedia = JSON.parse(String(update?.bound[0]));
    const writtenExtra = JSON.parse(String(update?.bound[1]));
    expect(writtenMedia[0]).toMatchObject({
      url: original,
      card_preview_status: 'unavailable',
    });
    expect(writtenMedia[0]).not.toHaveProperty('card_variants');
    expect(writtenExtra.card_variant_version).toBe(2);
  });

  test.each([
    ['ready', variants],
    ['unavailable', []],
  ] as const)(
    'Product Hunt extensionless direct GIF records preview status %s before advancing to v2',
    async (expectedStatus, generatedVariants) => {
      const directUrl = 'https://ph-files.example/asset-without-extension';
      const { env, calls } = fakeBackfillEnv([{
        id: `product_hunt:extensionless-${expectedStatus}`,
        source_type: 'product_hunt',
        media: JSON.stringify([{
          type: 'image',
          role: 'gallery',
          url: directUrl,
        }]),
        extra: JSON.stringify({ card_variant_version: 1 }),
      }], { remaining: 0 });
      const detectedSources: Array<Record<string, unknown>> = [];
      const generatedSources: Array<Record<string, unknown>> = [];

      const result = await runCardImageVariantBackfill(
        env,
        { dryRun: false, limit: 1 },
        {
          detectSourceContentType: async (source) => {
            detectedSources.push(source);
            return 'image/gif';
          },
          generate: async (_bucket, source) => {
            generatedSources.push(source);
            return [...generatedVariants];
          },
        },
      );

      expect(result).toMatchObject({
        updated: 1,
        transform_failed: expectedStatus === 'unavailable' ? 1 : 0,
      });
      expect(detectedSources[0]).toMatchObject({
        sourceUrl: directUrl,
        sourcePrefix: 'ph',
      });
      expect(generatedSources[0]).toMatchObject({
        sourceUrl: directUrl,
        sourceContentType: 'image/gif',
      });
      const update = calls.find((call) => /UPDATE items/.test(call.sql));
      const writtenMedia = JSON.parse(String(update?.bound[0]));
      const writtenExtra = JSON.parse(String(update?.bound[1]));
      expect(writtenMedia[0].card_preview_status).toBe(expectedStatus);
      if (expectedStatus === 'ready') {
        expect(writtenMedia[0].card_variants).toEqual(variants);
      } else {
        expect(writtenMedia[0]).not.toHaveProperty('card_variants');
      }
      expect(writtenExtra.card_variant_version).toBe(2);
    },
  );

  test('unsupported sources and source-less cards terminate without a transform target', () => {
    expect(locateCardVariantTarget('youtube', [], {})).toBeNull();
    expect(locateCardVariantTarget('hf_paper', [{ type: 'video', url: 'x.mp4' }], {})).toBeNull();
  });

  test('the ops route is authenticated, dry-run by default and never scheduled', () => {
    const source = fs.readFileSync(
      fileURLToPath(new NodeURL('./index.ts', import.meta.url)),
      'utf8',
    );
    const handlerStart = source.indexOf('async function handleEnrichRun');
    const handlerEnd = source.indexOf('// ─── GET /img', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const scheduledStart = source.indexOf('async scheduled(');
    const scheduled = source.slice(scheduledStart, handlerStart);

    expect(handler).toContain("mode === 'card-image-variant-backfill'");
    expect(handler).toContain("get('dry_run') !== '0'");
    expect(scheduled).not.toContain('runCardImageVariantBackfill(');
  });
});
