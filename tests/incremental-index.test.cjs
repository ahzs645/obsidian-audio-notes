const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const context = { exports: {}, setTimeout, clearTimeout };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/IncrementalIndex.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { IncrementalIndex } = context.exports;
function fixture(count = 3) {
  const f = { files: Array.from({ length: count }, (_, i) => ({ path: `${i}.json`, mtime: 1, size: 10 })), saved: null, reads: [] };
  f.host = { files: () => f.files, load: async () => f.saved, save: async data => { f.saved = data; },
    read: async file => { f.reads.push(file.path); return { path: file.path }; } };
  return f;
}
test('discovery reads no transcripts; a step processes one and restart resumes', async () => {
  const f = fixture(); const a = new IncrementalIndex(f.host);
  await a.initialize(); assert.equal(f.reads.length, 0);
  await a.step(); assert.equal(f.reads.length, 1); assert.equal(a.progress.complete, 1);
  const b = new IncrementalIndex(f.host); await b.initialize();
  assert.equal(b.progress.complete, 1); assert.equal(f.reads.length, 1);
  await b.step(); assert.deepEqual(f.reads, ['0.json', '1.json']);
});
test('changed records are invalidated and deleted records removed without content reads', async () => {
  const f = fixture(2); const a = new IncrementalIndex(f.host); await a.initialize();
  await a.step(); await a.step(); f.files[0].mtime = 2; f.files.pop(); a.reconcile();
  assert.equal(a.progress.total, 1); assert.equal(a.progress.complete, 0); assert.equal(a.entries.length, 0);
  assert.equal(f.reads.length, 2); await a.step(); assert.equal(a.progress.complete, 1);
});
test('unavailable files stay unresolved across restart, pending files continue first', async () => {
  const f = fixture(2); f.host.read = async file => { if (file.path === '0.json') throw Error('offline'); return { path: file.path }; };
  const a = new IncrementalIndex(f.host); await a.initialize(); await a.step();
  assert.equal(a.progress.unresolved, 1); const b = new IncrementalIndex(f.host); await b.initialize();
  assert.equal(b.progress.unresolved, 1); await b.step(); assert.equal(b.progress.complete, 1);
  f.host.read = async file => ({ path: file.path }); b.retry(); await b.step(); assert.equal(b.progress.complete, 2);
});
test('hung cloud reads time out and never create unbounded outstanding reads', async () => {
  const f = fixture(5); let started = 0; const resolve = [];
  f.host.read = () => { started++; return new Promise(r => resolve.push(r)); };
  const a = new IncrementalIndex(f.host, 5); await a.initialize();
  await a.step(); await a.step(); await a.step();
  assert.equal(started, 2); assert.equal(a.progress.unresolved, 2); assert.equal(a.progress.active, 2);
  resolve.forEach(r => r(null)); await Promise.resolve();
  a.stop(); await a.step(); assert.equal(started, 2);
});
test('file changed during read cannot checkpoint stale content', async () => {
  const f = fixture(1); f.host.read = async () => { f.files[0].mtime++; return { stale: true }; };
  const a = new IncrementalIndex(f.host); await a.initialize(); await a.step();
  assert.equal(a.progress.complete, 0); assert.equal(a.entries.length, 0);
});
test('new imports checkpoint immediately; ignored JSON also stays checked', async () => {
  const f = fixture(2); f.host.read = async () => null;
  const a = new IncrementalIndex(f.host); await a.initialize(); await a.record(f.files[0], { imported: true }); await a.step();
  const b = new IncrementalIndex(f.host); await b.initialize();
  assert.equal(b.progress.complete, 2); assert.equal(b.entries.length, 1);
});
test('corrupt checkpoints restart safely and persistence failures are visible', async () => {
  const f = fixture(1); f.saved = '{broken'; f.host.save = async () => { throw Error('disk full'); };
  const a = new IncrementalIndex(f.host); await a.initialize(); assert.equal(a.progress.pending, 1);
  await a.step(); assert.match(a.saveError, /could not be saved/);
});

function importerHarness() {
  const source = fs.readFileSync('src/WhisperImporter.ts', 'utf8') +
    '\nexport { getCatalog, getWhisperImportIndex, findExistingWhisperImport, serializeImport };';
  const ctx = { exports: {}, Buffer, console, require(name) {
    if (name === 'adm-zip') return { default: require('adm-zip') };
    if (name === 'obsidian') return { normalizePath: p => p.replace(/\\/g, '/') };
    if (name === './Transcript') return { parseTranscript: text => ({ segments: [{ id: 0, start: 0, end: 1, text }] }) };
    if (name === './IncrementalIndex') return { IncrementalIndex };
    if (name === './googleDriveArchive') return { isGoogleDriveArchiveEnabled: () => false, normalizeArchiveRelativePath: p => p, pathExists: async () => false };
    if (name.startsWith('./')) return {};
    return require(name);
  } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, ctx);
  const disk = new Map(); let reads = 0;
  const files = [{ path: 'transcripts/a.json', extension: 'json', stat: { mtime: 1, size: 10 } }];
  const plugin = () => ({ settings: { whisperTranscriptFolder: 'transcripts', whisperAudioFolder: 'audio' }, manifest: { dir: '.obsidian/plugins/audio' }, register() {}, app: { vault: {
    configDir: '.obsidian', getFiles: () => files,
    createFolder: async p => disk.set(p, ''),
    create: async (p, data) => { if (disk.has(p)) throw Error('exists'); disk.set(p, data); files.push({ path: p, extension: 'json', stat: { mtime: 2, size: data.length } }); },
    adapter: { writeBinary: async (p, data) => disk.set(p, data), stat: async p => files.find(f => f.path === p)?.stat, exists: async p => disk.has(p) || p === files[0].path,
      read: async p => { if (disk.has(p)) return disk.get(p); reads++; return JSON.stringify({ source: 'whisper', audioSha1: 'audio-hash', segmentsSha1: 'segments-hash', whisperFingerprint: 'fingerprint', durationMs: 1 }); },
      write: async (p, data) => disk.set(p, data), rename: async (a, b) => { disk.set(b, disk.get(a)); disk.delete(a); } },
  } } });
  return { api: ctx.exports, plugin, reads: () => reads, files };
}
test('unmatched lookups proceed without reading historical transcripts; restart keeps known hashes', async () => {
  const h = importerHarness(), p = h.plugin();
  const match = await h.api.findExistingWhisperImport(p, 'new-fingerprint', {}, 'new.whisper', 1, 'transcripts', 'new-hash');
  assert.equal(match, null); assert.equal(h.reads(), 0);
  const c = await h.api.getCatalog(p, 'transcripts'); await c.step();
  const reboot = await h.api.getWhisperImportIndex(h.plugin(), 'transcripts', 'incoming.whisper');
  assert.equal(reboot.byAudioSha1.get('audio-hash').size, 1); assert.equal(h.reads(), 1);
});
test('known duplicates still resolve while unrelated transcripts are pending', async () => {
  const h = importerHarness(), p = h.plugin(); const c = await h.api.getCatalog(p, 'transcripts'); await c.step();
  h.files.push({ path: 'transcripts/b.json', extension: 'json', stat: { mtime: 1, size: 10 } });
  const match = await h.api.findExistingWhisperImport(p, 'fingerprint', {}, 'incoming.whisper', 1, 'transcripts', 'audio-hash');
  assert.equal(match.transcriptPath, 'transcripts/a.json'); assert.equal(h.reads(), 1);
});
test('new import review is pending, survives restart, and flags a late historical match', async () => {
  const h = importerHarness(), p = h.plugin(); const c = await h.api.getCatalog(p, 'transcripts');
  const file = { path: 'transcripts/new.json', extension: 'json', stat: { mtime: 1, size: 10 } };
  h.files.push(file);
  await c.record({ path: file.path, ...file.stat }, { transcriptPath: file.path, duplicateReviewRequired: true, audioSha1: 'audio-hash', normalizedName: '', durationMs: 1 });
  let review = await h.api.getWhisperDuplicateReview(p);
  assert.equal(review[0].state, 'pending'); assert.equal(h.reads(), 0);
  const reboot = h.plugin(); review = await h.api.getWhisperDuplicateReview(reboot);
  assert.equal(review[0].state, 'pending');
  await (await h.api.getCatalog(reboot, 'transcripts')).step();
  review = await h.api.getWhisperDuplicateReview(reboot);
  assert.equal(review[0].state, 'possible-duplicate');
  assert.deepEqual([...review[0].matches], ['transcripts/a.json']);
  assert.equal(h.files.length, 2); // Reviewing never removes either record.
});
test('unmatched review becomes clear only when all historical entries are checked', async () => {
  const h = importerHarness(), p = h.plugin(); const c = await h.api.getCatalog(p, 'transcripts');
  const file = { path: 'transcripts/new.json', extension: 'json', stat: { mtime: 1, size: 10 } };
  h.files.push(file);
  await c.record({ path: file.path, ...file.stat }, { transcriptPath: file.path, duplicateReviewRequired: true, audioSha1: 'unique', normalizedName: '', durationMs: 1 });
  assert.equal((await h.api.getWhisperDuplicateReview(p))[0].state, 'pending');
  await c.step(); assert.equal((await h.api.getWhisperDuplicateReview(p))[0].state, 'clear');
  h.files[0].stat.mtime++; // Historical edit reopens uncertainty.
  assert.equal((await h.api.getWhisperDuplicateReview(p))[0].state, 'pending');
});
test('simultaneous VTT imports create one transcript without scanning historical JSON', async () => {
  const h = importerHarness(), p = h.plugin();
  const results = await Promise.allSettled([
    h.api.importVttFile(p, 'same new words', 'new.vtt', { createNote: false }),
    h.api.importVttFile(p, 'same new words', 'new.vtt', { createNote: false }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.duplicateCheckPending, true);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.name, 'WhisperDuplicateError');
  assert.equal(h.files.length, 2); assert.equal(h.reads(), 0);
  assert.equal((await h.api.getWhisperDuplicateReview(p))[0].state, 'pending');
});
test('Whisper archive imports immediately, then a repeat is skipped while history is still pending', async () => {
  const h = importerHarness(), p = h.plugin();
  const Zip = require('adm-zip'); const zip = new Zip();
  zip.addFile('originalAudio', Buffer.from('synthetic audio bytes'));
  zip.addFile('metadata.json', Buffer.from(JSON.stringify({ originalMediaFilename: 'new recording', originalMediaExtension: 'm4a', transcripts: [{ id: '1', start: 0, end: 1000, text: 'new words' }] })));
  const bytes = zip.toBuffer(); const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await h.api.importWhisperArchive(p, data, 'new.whisper', { createNote: false });
  assert.equal(result.duplicateCheckPending, true); assert.equal(h.reads(), 0);
  await assert.rejects(h.api.importWhisperArchive(p, data, 'new.whisper', { createNote: false }), { name: 'WhisperDuplicateError' });
  assert.equal(h.files.length, 2);
});
test('a failed import does not wedge the per-vault queue', async () => {
  const h = importerHarness(), p = h.plugin();
  await assert.rejects(h.api.serializeImport(p, async () => { throw Error('bad archive'); }), /bad archive/);
  assert.equal(await h.api.serializeImport(p, async () => 'next import'), 'next import');
});
