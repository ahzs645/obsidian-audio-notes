const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/AudioLinkRepair.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { planAudioLinkRepair, findSuspectNotes, isSameFileFamily } = context.exports;

const note = (path, mediaUri, sha1, day, importedPath = null) => ({
  path, title: path, mediaUri, fieldKey: 'media_uri', transcriptPath: `${path}.json`,
  dateParts: { year: '2026', month: '09', day }, sha1, importedPath,
});
function io(hashes) {
  const hashed = [];
  return {
    hashed,
    loadExpected: async n => ({ sha1: n.sha1, importedPath: n.importedPath }),
    hashFile: async p => { hashed.push(p); return hashes[p] ?? null; },
  };
}
const plain = value => JSON.parse(JSON.stringify(value));

// The vault state behind the original report: the Sep 16 meeting's folder was
// pulled under Sep 22, and the Sep 22 recording was merged in as "-1".
const nimt = 'MediaArchive/2026/09/22/nimt-system-audio';
const kiu = note('kiu.md', `${nimt}/system-audio-13.m4a`, 'kiu', '22', 'MediaArchive/2026/09/system-audio-13.m4a');
const sep16 = note('sep16.md', 'MediaArchive/2026/09/16/nimt-system-audio/system-audio-13.m4a', 'sep16', '16');
const healthy = note('ok.md', 'MediaArchive/2026/09/04/dzxx-system-audio/system-audio-8.m4a', 'ok', '04');
const files = [`${nimt}/system-audio-13.m4a`, `${nimt}/system-audio-13-1.m4a`, healthy.mediaUri];
const hashes = { [`${nimt}/system-audio-13.m4a`]: 'sep16', [`${nimt}/system-audio-13-1.m4a`]: 'kiu', [healthy.mediaUri]: 'ok' };

test('collision-renamed copies count as the same recording name', () => {
  assert.equal(isSameFileFamily('a/system-audio-13-1.m4a', 'b/system-audio-13.m4a'), true);
  assert.equal(isSameFileFamily('a/system-audio-13.m4a', 'b/system-audio-13.m4a'), true);
  assert.equal(isSameFileFamily('a/system-audio-13.wav', 'b/system-audio-13.m4a'), false);
  assert.equal(isSameFileFamily('a/other-13.m4a', 'b/system-audio-13.m4a'), false);
});

test('suspects are missing, shared or crowded links; a lone correct link is left alone', () => {
  const suspects = findSuspectNotes([kiu, sep16, healthy], files).map(n => n.path);
  assert.deepEqual(suspects, ['kiu.md', 'sep16.md']);
});

test('from one meeting, both swapped meetings are relinked and the stray recording moves home', async () => {
  const fake = io(hashes);
  const plan = await planAudioLinkRepair([kiu, sep16, healthy], files, fake, 'kiu.md');
  assert.deepEqual(plain(plan.relinks.map(r => [r.note.path, r.to])), [
    ['kiu.md', `${nimt}/system-audio-13-1.m4a`],
    ['sep16.md', `${nimt}/system-audio-13.m4a`],
  ]);
  // The folder sits under the 22nd, so the Sep 22 recording keeps it.
  assert.deepEqual(plain(plan.moves.map(m => [m.file, m.notes.map(n => n.path), m.dateParts.day])), [
    [`${nimt}/system-audio-13.m4a`, ['sep16.md'], '16'],
  ]);
  assert.deepEqual(plain(plan.missing), []);
  assert.equal(fake.hashed.includes(healthy.mediaUri), false);
});

test('a recording another meeting correctly owns is never taken', async () => {
  const owner = note('owner.md', 'MediaArchive/2026/09/10/aaaa-x/system-audio-2.m4a', 'owner', '10');
  const lost = note('lost.md', 'MediaArchive/2026/09/11/gone/system-audio-2.m4a', 'lost', '11');
  const plan = await planAudioLinkRepair([owner, lost], [owner.mediaUri], io({ [owner.mediaUri]: 'owner' }));
  assert.deepEqual(plain(plan.relinks), []);
  assert.deepEqual(plain(plan.missing.map(n => n.path)), ['lost.md']);
});

test('duplicate notes of one meeting may share a recording', async () => {
  const shared = 'MediaArchive/2026/09/01/isnf-system-audio/system-audio.m4a';
  const a = { ...note('a.md', shared, 'same', '01'), transcriptPath: 'a.json' };
  const b = { ...note('b.md', shared, 'same', '01'), transcriptPath: 'b.json' };
  const plan = await planAudioLinkRepair([a, b], [shared], io({ [shared]: 'same' }));
  assert.equal(plan.checked, 2);
  assert.deepEqual(plain(plan.relinks), []);
  assert.deepEqual(plain(plan.moves), []);
});

test('the search stays in the meeting month and stops at the first match', async () => {
  const lost = note('lost.md', 'MediaArchive/2026/09/05/gone/system-audio-4.m4a', 'mine', '05');
  const july = 'MediaArchive/2026/07/01/abcd-system-audio/system-audio-4.m4a';
  const septA = 'MediaArchive/2026/09/05/efgh-system-audio/system-audio-4-1.m4a';
  const septB = 'MediaArchive/2026/09/05/efgh-system-audio/system-audio-4.m4a';
  const fake = io({ [septA]: 'mine', [septB]: 'other', [july]: 'mine' });
  const plan = await planAudioLinkRepair([lost], [july, septA, septB], fake);
  assert.deepEqual(plain(plan.relinks.map(r => r.to)), [septA]);
  assert.deepEqual(fake.hashed, [septB, septA]);
});

test('meetings without a transcript fingerprint are skipped, not guessed', async () => {
  const old = note('old.md', 'MediaArchive/2025/03/gone.m4a', null, '03');
  const plan = await planAudioLinkRepair([old], [], io({}));
  assert.equal(plan.unverifiable, 1);
  assert.deepEqual(plain(plan.missing), []);
});
