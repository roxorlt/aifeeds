import { readFile, writeFile } from 'node:fs/promises';

import { publishIndexes } from '../../publish-indexes.mjs';

const [siteRoot, stateDir, stateFile, readyFile, phase] = process.argv.slice(2);
if (!siteRoot || !stateDir || !stateFile || !readyFile || !phase) {
  throw new Error('missing publish-and-pause fixture arguments');
}

const state = JSON.parse(await readFile(stateFile, 'utf8'));
const pause = async (actualPhase) => {
  if (phase !== actualPhase) return;
  await writeFile(readyFile, `${actualPhase}\n`);
  await new Promise(() => {
    setInterval(() => {}, 1_000);
  });
};

await publishIndexes({
  siteRoot,
  stateDir,
  state,
  hooks: {
    afterPrepared: () => pause('afterPrepared'),
    afterCurrentSwap: () => pause('afterCurrentSwap'),
  },
});
