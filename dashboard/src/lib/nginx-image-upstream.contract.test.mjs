import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDeploy = (name) => readFileSync(
  new URL(`../../../deploy/nginx/${name}`, import.meta.url),
  "utf8",
);

test("image upstream apply is checksum-gated and mutates only the /img block", () => {
  const script = readDeploy("aifeeds-image-transform-upstream-apply.sh");
  assert.match(script, /9303f443c9530a06ae2339c735151206a2011d65e03fdfebcf96c123a5c8dfb3/);
  assert.match(script, /55630f8c73aa8ee9cce056daa064788d57cbc54be48a354b3f163f6441ba6837/);
  assert.match(script, /location \/img/);
  assert.match(script, /xlist-api\.ltsms86\.workers\.dev/);
  assert.match(script, /image-api\.ai-feeds\.com/);
  assert.match(script, /Content-Type:[^\n]*image\/avif|content-type:[^\n]*image\/avif/i);
  assert.match(script, /X-Origin-Secret/);
  assert.match(script, /curl[\s\S]*--config -/);
  assert.match(script, /value\[0\] == value\[-1\]/);
  assert.doesNotMatch(script, /-H "X-Origin-Secret: \$origin_secret"/);
  assert.match(script, /nginx -t[\s\S]*systemctl reload nginx/);
  assert.match(script, /activated\.sha256/);
  assert.match(script, /grep -R -l -Z -a '\/img\?'/);
  assert.doesNotMatch(script, /rm -rf|find [^\n]*-delete/);
});

test("image upstream rollback refuses drift and rescues a failed rollback", () => {
  const script = readDeploy("aifeeds-image-transform-upstream-rollback.sh");
  assert.match(script, /\/root\/aifeeds-image-transform-upstream-/);
  assert.match(script, /activated\.sha256/);
  assert.match(script, /sha256sum -c "\$backup_dir\/activated\.sha256"/);
  assert.match(script, /trap restore_on_error ERR/);
  assert.match(script, /rollback_failed/);
  assert.match(script, /nginx -t[\s\S]*systemctl reload nginx/);
  assert.match(script, /grep -R -l -Z -a '\/img\?'/);
  assert.doesNotMatch(script, /rm -rf|find [^\n]*-delete/);
});
