import type { Plugin } from 'vite';

// Exact build outputs only: never assign immutable caching to HTML, API,
// public-directory files, source maps, or a wildcard that also matches 404s.
export function buildAssetCacheHeaders(fileNames: string[]): string {
  const paths = [...new Set(fileNames.filter((name) => /\.(?:js|css)$/.test(name)))].sort();
  for (const name of paths) {
    if (!/^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(name)) {
      throw new Error(`Refusing immutable cache for non-hashed build output: ${name}`);
    }
  }
  // Cloudflare Pages accepts at most 100 static header rules.
  if (paths.length > 100) throw new Error('Asset cache headers exceed Pages 100-rule limit');
  return paths.map((name) => `/${name}\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n');
}

export function assetCacheHeadersPlugin(): Plugin {
  return {
    name: 'aifeeds-asset-cache-headers',
    apply: 'build',
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: buildAssetCacheHeaders(Object.keys(bundle)),
      });
    },
  };
}
