const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const mods={};
const load=file=>{if(mods[file])return mods[file];const mod={exports:{}};mods[file]=mod.exports;
 const req=name=>name==='./meeting-labels'?load('src/meeting-labels.ts'):require(name);
 new Function('exports','module','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod.exports,mod,req);return mods[file]=mod.exports;};
const E=load('src/meeting-events.ts');

const note=(path,frontmatter)=>({file:{path,basename:path.split('/').pop().replace(/\.md$/,''),extension:'md'},frontmatter});
const notes=[
 note('meetings/A.md',{tags:['meeting','job/northern-health'],meeting_label:'job/northern-health',start_date:'2026-04-08',start_time:'10:00',end_date:'2026-04-08',end_time:'10:30'}),
 note('meetings/B.md',{tags:['meeting'],start_date:'2026-04-09',start_time:'09:00'}),
 note('notes/Not a meeting.md',{start_date:'2026-04-09'}),
];
const app={vault:{getMarkdownFiles:()=>notes.map(n=>n.file)},metadataCache:{getFileCache:f=>({frontmatter:notes.find(n=>n.file===f).frontmatter})}};

test('the vault-wide calendar sees every meeting',()=>{
 assert.deepEqual(E.collectMeetingEvents(app,{},[]).map(e=>e.title),['A','B']);
});
test('a Bases calendar shows only the meetings its query returned',()=>{
 const events=E.collectMeetingEventsForFiles(app,[notes[1].file,notes[2].file,notes[1].file],{},[]);
 assert.deepEqual(events.map(e=>e.title),['B']);
});
test('labelled meetings get their label color and friendly name',()=>{
 const [a]=E.collectMeetingEventsForFiles(app,[notes[0].file],{},[{id:'j',name:'Job',tagPrefix:'Job'}]);
 assert.equal(a.label.fullName,'Job › Northern Health');assert.match(a.color,/^#[0-9a-f]{6}$/);
 const [b]=E.collectMeetingEventsForFiles(app,[notes[0].file],{job:'#123456'},[{id:'j',name:'Job',tagPrefix:'Job'}]);
 assert.equal(b.color,'#123456');
});
