const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const mod={exports:{}};
new Function('exports','module',ts.transpileModule(fs.readFileSync('src/MeetingMetadataRepair.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod.exports,mod);
const R=mod.exports;
const weekly=d=>`${d.getFullYear()}-W${String(Math.ceil(((d-new Date(d.getFullYear(),0,1))/864e5+1)/7)).padStart(2,'0')}`;
const note=(basename,fm)=>({path:`meetings/${basename}.md`,basename,frontmatter:fm});

test('a numeric recorder title is replaced with the note name',()=>{
 const [c]=R.planMetadataRepair([note('Bug Reporting System',{title:4,media_uri:'MediaArchive/2025/12/4.m4a'})],{});
 assert.deepEqual(c.updates,{title:'Bug Reporting System'});
});
test('a recorder title matching the slugged audio file is replaced',()=>{
 const [c]=R.planMetadataRepair([note('Teladoc Integration Meeting',{title:'Mar 27 3.59.43 PM System Audio+Microphone',media_uri:'x/r-27/mar-27-35943-pm-system-audiomicrophone.m4a'})],{});
 assert.equal(c.updates.title,'Teladoc Integration Meeting');
});
test('narrow no-break spaces alone are normalized to the file name',()=>{
 const [c]=R.planMetadataRepair([note('Mar 3 11.20.59 AM System Audio',{title:'Mar 3 11.20.59 AM System Audio'})],{});
 assert.equal(c.updates.title,'Mar 3 11.20.59 AM System Audio');
});
test('a deliberately different title is left alone',()=>{
 assert.deepEqual(R.planMetadataRepair([note('2026-04-08 Sync',{title:'Weekly sync with Margot',media_uri:'a/b.m4a'})],{}),[]);
});
test('periodic references are recomputed from the local start',()=>{
 const [c]=R.planMetadataRepair([note('A',{title:'A',start_date:'2025-12-03',start_time:'11:04:48',weekly_note:"2025-'W'49",daily_note:'2025-12-03'})],{weekly:()=>'2025-W49',daily:d=>d.toISOString().slice(0,10)&&'2025-12-03'});
 assert.deepEqual(c.updates,{weekly_note:'2025-W49'});
});
test('missing periodic keys are not added',()=>{
 assert.deepEqual(R.planMetadataRepair([note('A',{title:'A',start_date:'2025-12-03'})],{weekly,daily:()=>'x'}),[]);
});
test('summary counts each kind',()=>{
 assert.equal(R.summarizeRepair([{path:'a',updates:{title:'x',weekly_note:'y'}},{path:'b',updates:{weekly_note:'y'}}]),'1 titles reset to the note\'s name, 2 weekly note references');
});
