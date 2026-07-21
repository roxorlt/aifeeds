import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  completePreparingDeployment,
  prepareGlobalDeployment,
  publishGlobalJournalMarker,
  recordPreparingRecoveryStep,
  recoverGlobalDeployment,
} from '../../deployment-file-transaction.mjs';
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
    hookName = 'afterMarkerPublishBeforeCandidateUnlink',
  ] = process.argv.slice(2);
  const pause = async () => {
    await writeFile(ready, 'ready\n');
    await new Promise(() => {
      setInterval(() => {}, 1_000);
    });
  };
  await publishGlobalJournalMarker({
    canonical,
    gid: Number(gidText),
    hooks: { [hookName]: pause },
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

if (process.argv[2] === 'preparing-marker-update') {
  const [, root, hookName, ready] = process.argv.slice(2);
  const uid = process.getuid();
  const gid = process.getgid();
  const releases = `${root}/aifeeds-cc-sync-releases`;
  const manifest = 'a'.repeat(64);
  const release = `${releases}/${manifest}`;
  const preparingJournal = `${releases}/.deployment-preparing.json`;
  const committedJournal = `${releases}/.deployment-committed.json`;
  const journalDirectory = `${releases}/.deployment-journal`;
  const snapshot = `${root}/var/lib/aifeeds-cc-deploy-snapshots/aifeeds-cc-root-snapshot.ABC123`;
  const destinations = [
    `${root}/aifeeds-cc-sync`,
    `${root}/systemd/aifeeds-cc-sync.service`,
    `${root}/systemd/aifeeds-cc-sync.timer`,
    `${root}/aifeeds/cc-sync.env`,
  ];
  await mkdir(release, { mode: 0o755, recursive: true });
  await chmod(releases, 0o755);
  await chmod(release, 0o755);
  await mkdir(`${root}/systemd`, { recursive: true });
  await mkdir(`${root}/aifeeds`, { recursive: true });
  await mkdir(snapshot, { mode: 0o755, recursive: true });
  await chmod(`${root}/var/lib/aifeeds-cc-deploy-snapshots`, 0o700);
  await chmod(snapshot, 0o755);
  await prepareGlobalDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    manifest,
    nginxTransaction: `${snapshot}/.rollback/nginx`,
    preparingJournal,
    release,
    releases,
    runtime: {
      service_active: 'inactive',
      timer_active: 'inactive',
      timer_enabled: 'disabled',
    },
    uid,
  });
  const pause = async () => {
    await writeFile(ready, `${hookName}\n`);
    await new Promise(() => {
      setInterval(() => {}, 1_000);
    });
  };
  await recordPreparingRecoveryStep({
    committedJournal,
    destinations,
    gid,
    hooks: { [hookName]: pause },
    journalDirectory,
    preparingJournal,
    releases,
    state: 'attempted',
    step: 'candidate_timer_stop',
    uid,
  });
  process.exit(0);
}

if (process.argv[2] === 'cleanup-receipt-create') {
  const [, root, hookName, ready] = process.argv.slice(2);
  const uid = process.getuid();
  const gid = process.getgid();
  const releases = `${root}/aifeeds-cc-sync-releases`;
  const manifest = 'a'.repeat(64);
  const release = `${releases}/${manifest}`;
  const preparingJournal = `${releases}/.deployment-preparing.json`;
  const committedJournal = `${releases}/.deployment-committed.json`;
  const journalDirectory = `${releases}/.deployment-journal`;
  const snapshot = `${root}/var/lib/aifeeds-cc-deploy-snapshots/aifeeds-cc-root-snapshot.ABC123`;
  const destinations = [
    `${root}/aifeeds-cc-sync`,
    `${root}/systemd/aifeeds-cc-sync.service`,
    `${root}/systemd/aifeeds-cc-sync.timer`,
    `${root}/aifeeds/cc-sync.env`,
  ];
  await mkdir(release, { mode: 0o755, recursive: true });
  await chmod(releases, 0o755);
  await chmod(release, 0o755);
  await mkdir(`${root}/systemd`, { recursive: true });
  await mkdir(`${root}/aifeeds`, { recursive: true });
  await mkdir(snapshot, { mode: 0o755, recursive: true });
  await chmod(`${root}/var/lib/aifeeds-cc-deploy-snapshots`, 0o700);
  await chmod(snapshot, 0o755);
  await prepareGlobalDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    manifest,
    nginxTransaction: `${snapshot}/.rollback/nginx`,
    preparingJournal,
    release,
    releases,
    runtime: {
      service_active: 'inactive',
      timer_active: 'inactive',
      timer_enabled: 'disabled',
    },
    uid,
  });
  const pause = async ({ action, location }) => {
    if (action !== 'create' || location !== 'snapshot-cleanup') return;
    await writeFile(ready, `${hookName}\n`);
    await new Promise(() => {
      setInterval(() => {}, 1_000);
    });
  };
  await completePreparingDeployment({
    committedJournal,
    destinations,
    gid,
    hooks: { [hookName]: pause },
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  process.exit(0);
}

if (process.argv[2] === 'cleanup-mutation') {
  const [, root, targetMutation, hookName, ready] = process.argv.slice(2);
  const uid = process.getuid();
  const gid = process.getgid();
  const releases = `${root}/aifeeds-cc-sync-releases`;
  const manifest = 'a'.repeat(64);
  const release = `${releases}/${manifest}`;
  const preparingJournal = `${releases}/.deployment-preparing.json`;
  const committedJournal = `${releases}/.deployment-committed.json`;
  const journalDirectory = `${releases}/.deployment-journal`;
  const snapshot = `${root}/var/lib/aifeeds-cc-deploy-snapshots/aifeeds-cc-root-snapshot.ABC123`;
  const destinations = [
    `${root}/aifeeds-cc-sync`,
    `${root}/systemd/aifeeds-cc-sync.service`,
    `${root}/systemd/aifeeds-cc-sync.timer`,
    `${root}/aifeeds/cc-sync.env`,
  ];
  await mkdir(release, { mode: 0o755, recursive: true });
  await chmod(releases, 0o755);
  await chmod(release, 0o755);
  await mkdir(`${root}/systemd`, { recursive: true });
  await mkdir(`${root}/aifeeds`, { recursive: true });
  await mkdir(snapshot, { mode: 0o755, recursive: true });
  await chmod(`${root}/var/lib/aifeeds-cc-deploy-snapshots`, 0o700);
  await chmod(snapshot, 0o755);
  await prepareGlobalDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    manifest,
    nginxTransaction: `${snapshot}/.rollback/nginx`,
    preparingJournal,
    release,
    releases,
    runtime: {
      service_active: 'inactive',
      timer_active: 'inactive',
      timer_enabled: 'disabled',
    },
    uid,
  });
  const pause = async ({ action, location }) => {
    const matches = (
      targetMutation === 'preparing-delete'
      && action === 'delete'
      && location === 'global'
    ) || (
      targetMutation === 'cleanup-replace'
      && action === 'replace'
      && location === 'snapshot-cleanup'
    ) || (
      targetMutation === 'cleanup-delete'
      && action === 'delete'
      && location === 'snapshot-cleanup'
    );
    if (!matches) return;
    await writeFile(ready, `${targetMutation}:${hookName}\n`);
    await new Promise(() => {
      setInterval(() => {}, 1_000);
    });
  };
  await completePreparingDeployment({
    committedJournal,
    destinations,
    gid,
    hooks: { [hookName]: pause },
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  process.exit(0);
}

if (process.argv[2] === 'recover-committed-and-pause') {
  const [, optionsFile, ready] = process.argv.slice(2);
  const options = JSON.parse(await readFile(optionsFile, 'utf8'));
  await recoverGlobalDeployment({
    ...options,
    hooks: {
      async afterMarkerRemovalBeforeSnapshotDelete() {
        await writeFile(ready, 'snapshot-delete-paused\n');
        await new Promise(() => {
          setInterval(() => {}, 1_000);
        });
      },
    },
  });
  process.exit(0);
}

if (process.argv[2] === 'recover-committed-after-quarantine-delete-pause') {
  const [, optionsFile, ready] = process.argv.slice(2);
  const options = JSON.parse(await readFile(optionsFile, 'utf8'));
  await recoverGlobalDeployment({
    ...options,
    hooks: {
      async afterSnapshotQuarantineRemovalBeforeReceiptUnlink() {
        await writeFile(ready, 'receipt-unlink-paused\n');
        await new Promise(() => {
          setInterval(() => {}, 1_000);
        });
      },
    },
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
