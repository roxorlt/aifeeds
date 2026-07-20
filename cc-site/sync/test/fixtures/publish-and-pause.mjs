import { readFile, writeFile } from 'node:fs/promises';

import { publishGlobalJournalMarker } from '../../deployment-file-transaction.mjs';
import { publishIndexes } from '../../publish-indexes.mjs';

if (process.argv[2] === 'global-journal') {
  const [
    ,
    phase,
    canonical,
    journalDirectory,
    uidText,
    gidText,
    ready,
  ] = process.argv.slice(2);
  await publishGlobalJournalMarker({
    canonical,
    gid: Number(gidText),
    hooks: {
      async afterMarkerPublishBeforeCandidateUnlink() {
        await writeFile(ready, 'ready\n');
        await new Promise(() => {
          setInterval(() => {}, 1_000);
        });
      },
    },
    journalDirectory,
    marker: {
      manifest: 'a'.repeat(64),
      phase,
      release: `/opt/aifeeds-cc-sync-releases/${'a'.repeat(64)}`,
      schema: 2,
      transactions: [],
    },
    phase,
    uid: Number(uidText),
  });
  process.exit(0);
}

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
