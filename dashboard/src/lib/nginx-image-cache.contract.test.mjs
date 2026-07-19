import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDeploy = (name) => readFileSync(
  new URL(`../../../deploy/nginx/${name}`, import.meta.url),
  "utf8",
);

test("image cache apply script uses a finite Accept bucket and a bucketed cache key", () => {
  const script = readDeploy("aifeeds-image-format-cache-apply.sh");
  assert.match(script, /map \$http_accept \$aifeeds_image_format/);
  assert.match(script, /map \$http_accept \$aifeeds_image_format_skip_cache/);
  assert.match(script, /~\*image\/avif[\s\S]*avif/);
  assert.match(script, /~\*image\/webp[\s\S]*webp/);
  assert.match(script, /default[\s\S]*original/);
  assert.match(script, /\$request_uri\|fmt=\$aifeeds_image_format/);
  assert.match(script, /proxy_no_cache[\s\S]*\$aifeeds_image_format_skip_cache/);
  assert.match(script, /proxy_cache_bypass[\s\S]*\$aifeeds_image_format_skip_cache/);
});

test("production mutation is checksum-gated, backed up, syntax-tested, and narrowly purged", () => {
  const script = readDeploy("aifeeds-image-format-cache-apply.sh");
  assert.match(script, /0446c7076e8ca1dfdf1e591e74dd6a559a9599791fd2659589edba80f36c2214/);
  assert.match(script, /cd78847ba901509575e9c0df8c5674fe1b86723906da7216f2a486a1b0a74795/);
  assert.match(script, /install -d -m 700/);
  assert.match(script, /nginx -t[\s\S]*systemctl reload nginx/);
  assert.match(script, /grep -R -l -Z -a '\/img\?'/);
  assert.doesNotMatch(script, /rm -rf|find [^\n]*-delete/);
});

test("rollback restores only an apply-created backup and repeats validation and targeted purge", () => {
  const script = readDeploy("aifeeds-image-format-cache-rollback.sh");
  assert.match(script, /\/root\/aifeeds-image-format-cache-/);
  assert.match(script, /nginx -t[\s\S]*systemctl reload nginx/);
  assert.match(script, /grep -R -l -Z -a '\/img\?'/);
  assert.doesNotMatch(script, /rm -rf|find [^\n]*-delete/);
});
