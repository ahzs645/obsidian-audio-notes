const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/MediaPathSync.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { remapRenamedPath, planPathFieldUpdates } = context.exports;
const plain = value => JSON.parse(JSON.stringify(value));

// The vault state behind the report: a later meeting pulled the Jul 16
// recording folder under Aug 25, and four notes that linked into it broke.
const jul16 = 'MediaArchive/2026/07/16/gvhm-system-audio';
const aug25 = 'MediaArchive/2026/08/25/gvhm-system-audio';

test('a moved folder carries every link inside it along', () => {
  for (const name of ['system-audio-2.m4a', 'system-audio-2-1.m4a', 'system-audio-2-3.m4a']) {
    assert.equal(remapRenamedPath(`${jul16}/${name}`, jul16, aug25), `${aug25}/${name}`);
  }
});

test('a moved file updates links to exactly that file', () => {
  const from = 'MediaArchive/2026/09/system-audio-13.m4a';
  const to = 'MediaArchive/2026/09/16/nimt-system-audio/system-audio-13.m4a';
  assert.equal(remapRenamedPath(from, from, to), to);
  assert.equal(remapRenamedPath(` ${from} `, from, to), to);
});

test('look-alike names and sibling folders are left alone', () => {
  const file = 'MediaArchive/2026/09/system-audio-1.m4a';
  assert.equal(remapRenamedPath('MediaArchive/2026/09/system-audio-1.m4a.bak', file, 'x.m4a'), null);
  assert.equal(remapRenamedPath('MediaArchive/2026/09/system-audio-13.m4a', 'MediaArchive/2026/09/system-audio-1', 'y'), null);
  assert.equal(remapRenamedPath(`${jul16}-old/system-audio-2.m4a`, jul16, aug25), null);
  assert.equal(remapRenamedPath(`${jul16}/a.m4a`, jul16, jul16), null);
  assert.equal(remapRenamedPath(42, jul16, aug25), null);
  assert.equal(remapRenamedPath(undefined, jul16, aug25), null);
});

test('recording and transcript fields follow; other fields never change', () => {
  const fm = {
    title: `${jul16}/system-audio-2.m4a`,
    media_uri: `${jul16}/system-audio-2.m4a`,
    transcript_uri: 'transcripts/2026/07/system-audio-2.json',
    daily_note: '2026-07-16',
  };
  assert.deepEqual(plain(planPathFieldUpdates(fm, jul16, aug25)), {
    media_uri: `${aug25}/system-audio-2.m4a`,
  });
  assert.deepEqual(plain(planPathFieldUpdates(fm, 'transcripts/2026/07', 'transcripts/2026/07/16')), {
    transcript_uri: 'transcripts/2026/07/16/system-audio-2.json',
  });
  assert.deepEqual(plain(planPathFieldUpdates({ audio: `${jul16}/x.m4a` }, jul16, aug25)), {
    audio: `${aug25}/x.m4a`,
  });
});

test('a note already relinked elsewhere is not pulled back', () => {
  // The repair modal moves a file, then points the note at its real recording;
  // the live re-check sees the new value and plans nothing.
  const relinked = { media_uri: 'MediaArchive/2026/07/30/t4ne-system-audio/system-audio.m4a' };
  assert.deepEqual(plain(planPathFieldUpdates(relinked, jul16, aug25)), {});
  assert.deepEqual(plain(planPathFieldUpdates(null, jul16, aug25)), {});
});
