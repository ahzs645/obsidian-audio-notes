// End-to-end split against an in-memory vault and a real M4A (macOS only).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const esbuild=require('esbuild'),yaml=require('js-yaml'),moment=require('moment');
const hasAf=(()=>{try{execFileSync('which',['afconvert']);return true;}catch{return false;}})();

class TFile{constructor(p,vault){this.vault=vault;this.setPath(p);this.stat={ctime:0,mtime:0,size:0};}
 setPath(p){this.path=p;this.name=p.split('/').pop();this.basename=this.name.replace(/\.[^.]+$/,'');this.extension=this.name.split('.').pop();this.parent={path:p.split('/').slice(0,-1).join('/')};}}
function makeVault(){
 const files=new Map(),trashed=[];
 const split=t=>{const m=/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);return m?[yaml.load(m[1],{schema:yaml.CORE_SCHEMA})||{},m[2]]:[{},t];};
 const join=(fm,body)=>`---\n${yaml.dump(fm)}---\n${body}`;
 const vault={files,trashed,
  getAbstractFileByPath:p=>files.get(p)?.file??null,
  getMarkdownFiles:()=>[...files.values()].map(e=>e.file).filter(f=>f.extension==='md'),
  read:async f=>files.get(f.path).data,
  readBinary:async f=>{const d=files.get(f.path).data;return d.buffer.slice(d.byteOffset,d.byteOffset+d.byteLength);},
  create:async(p,data)=>{if(files.has(p))throw Error('exists '+p);const file=new TFile(p,vault);files.set(p,{file,data});return file;},
  createBinary:async(p,data)=>{if(files.has(p))throw Error('exists '+p);const file=new TFile(p,vault);files.set(p,{file,data:new Uint8Array(data)});return file;},
  process:async(f,fn)=>{const e=files.get(f.path);e.data=fn(e.data);return e.data;},
  trash:async f=>{trashed.push(f.path);files.delete(f.path);},
  delete:async f=>{files.delete(f.path);},
  createFolder:async()=>{},
  adapter:{exists:async p=>files.has(p)||[...files.keys()].some(k=>k.startsWith(p+'/'))},
 };
 const app={vault,
  metadataCache:{getFileCache:f=>{const e=files.get(f.path);if(!e||f.extension!=='md')return null;const [fm]=split(e.data);return {frontmatter:fm};}},
  fileManager:{
   processFrontMatter:async(f,fn)=>{const e=files.get(f.path);const [fm,body]=split(e.data);fn(fm);e.data=join(fm,body);},
   renameFile:async(f,p)=>{const e=files.get(f.path);files.delete(f.path);f.setPath(p);files.set(p,e);},
  },
 };
 return {app,split};
}
const obsidianStub={TFile,normalizePath:p=>p.replace(/\/+/g,'/').replace(/^\/|\/$/g,''),moment,Notice:class{},Modal:class{},Vault:class{},request:async()=>'',setIcon(){},Setting:class{}};

async function loadService(){
 const out=await esbuild.build({entryPoints:['src/services/MeetingSplitService.ts'],bundle:true,platform:'node',format:'cjs',external:['obsidian','electron'],write:false,logLevel:'error'});
 const mod={exports:{}};
 new Function('module','exports','require',out.outputFiles[0].text)(mod,mod.exports,n=>n==='obsidian'?obsidianStub:require(n));
 return mod.exports;
}

function toneM4a(dir){
 const rate=48000,n=rate*8,wav=Buffer.alloc(44+n*2);
 wav.write('RIFF',0);wav.writeUInt32LE(36+n*2,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*330/rate)*9000),44+i*2);
 fs.writeFileSync(path.join(dir,'t.wav'),wav);execFileSync('afconvert',['-f','m4af','-d','aac',path.join(dir,'t.wav'),path.join(dir,'t.m4a')]);
 return new Uint8Array(fs.readFileSync(path.join(dir,'t.m4a')));
}

test('splitting a meeting writes both parts and only then rewires the original note',{skip:!hasAf},async()=>{
 const {MeetingSplitService}=await loadService();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aan-split-'));
 const {app,split}=makeVault();
 await app.vault.createBinary('MediaArchive/2026/04/rec.m4a',toneM4a(dir).buffer);
 await app.vault.create('transcripts/2026/04/rec.json',JSON.stringify({source:'whisper',audioSha1:'orig',whisperFingerprint:'fp',segments:[
  {id:0,start:0.5,end:2.5,text:'First meeting wraps up.'},
  {id:1,start:5,end:7,text:'Second meeting begins.',words:[{text:' Second',start:5,end:5.5},{text:' meeting',start:5.5,end:6},{text:' begins.',start:6,end:7}]}]}));
 await app.vault.create('meetings/Recorded call.md',`---\ntitle: Recorded call\nmedia_uri: MediaArchive/2026/04/rec.m4a\ntranscript_uri: transcripts/2026/04/rec.json\nstart: ${new Date('2026-04-08T10:00:00').toISOString()}\nend: ${new Date('2026-04-08T11:00:00').toISOString()}\nstart_date: 2026-04-08\nstart_time: '10:00:00'\nend_date: 2026-04-08\nend_time: '11:00:00'\ntags: [meeting, job/northern-health]\nmeeting_label: job/northern-health\nattendees: [Sam]\n---\n\n> [!info] Schedule\n> - **When:** Wed\n> - **Time:** 10 → 11\n> - **Duration:** 1h\n> - **Timezone:** X\n> A quote after the callout.\n\n## Notes\nOld notes.\n`);
 const plugin={app,settings:{meetingTemplateEnabled:true,periodicDailyNoteEnabled:true,periodicDailyNoteFormat:'YYYY-MM-DD',periodicWeeklyNoteEnabled:true,periodicWeeklyNoteFormat:"gggg-'W'WW"}};
 const note=app.vault.getAbstractFileByPath('meetings/Recorded call.md');
 const progress=[];
 const outcome=await new MeetingSplitService(plugin).split({file:note,audioPath:'MediaArchive/2026/04/rec.m4a',transcriptPath:'transcripts/2026/04/rec.json',
  splitSec:4,firstTitle:'Rotation sync',secondTitle:'Discharge pilot',copyLabelAndAttendees:true,trashOriginals:true},m=>progress.push(m));

 assert.ok(outcome.audioCut);assert.equal(outcome.reencoded,false);assert.ok(Math.abs(outcome.splitSec-4)<0.03);
 assert.deepEqual(app.vault.trashed.sort(),['MediaArchive/2026/04/rec.m4a','transcripts/2026/04/rec.json']);
 // Audio parts are real, decodable files of the right length.
 for(const [n,len] of [[1,4],[2,4]]){const p=`MediaArchive/2026/04/rec-part-${n}.m4a`;const f=path.join(dir,`p${n}.m4a`);fs.writeFileSync(f,app.vault.files.get(p).data);
  const sec=Number(/estimated duration: ([\d.]+)/.exec(execFileSync('afinfo',[f]).toString())[1]);assert.ok(Math.abs(sec-len)<0.1,`part ${n} ${sec}s`);}
 // Transcripts are rebased and fingerprints kept / suffixed.
 const t1=JSON.parse(app.vault.files.get('transcripts/2026/04/rec-part-1.json').data),t2=JSON.parse(app.vault.files.get('transcripts/2026/04/rec-part-2.json').data);
 assert.deepEqual(t1.segments.map(s=>s.text),['First meeting wraps up.']);assert.equal(t1.whisperFingerprint,'fp');assert.equal(t1.audioPath,'MediaArchive/2026/04/rec-part-1.m4a');assert.notEqual(t1.audioSha1,'orig');
 assert.ok(Math.abs(t2.segments[0].start-(5-outcome.splitSec))<0.05);assert.equal(t2.whisperFingerprint,'fp#part-2');assert.equal(t2.splitFrom.part,2);
 // The original note is renamed, rewired, shortened, and its body keeps everything but the old callout.
 const first=app.vault.files.get('meetings/Rotation sync.md');assert.ok(first,'first note renamed');
 const [fm1,body1]=split(first.data);
 assert.equal(fm1.media_uri,'MediaArchive/2026/04/rec-part-1.m4a');assert.equal(fm1.transcript_uri,'transcripts/2026/04/rec-part-1.json');
 assert.equal(fm1.title,'Rotation sync');assert.ok(Math.abs(new Date(fm1.end).getTime()-(new Date('2026-04-08T10:00:00').getTime()+outcome.splitSec*1000))<1000);assert.equal(fm1.end_time,'10:00:04');
 assert.match(body1,/> A quote after the callout\./);assert.match(body1,/Old notes\./);assert.doesNotMatch(body1,/\*\*Duration:\*\* 1h/);
 // The new note carries the label, attendees and the rest of the time.
 const [fm2]=split(app.vault.files.get(outcome.secondNotePath).data);
 assert.equal(outcome.secondNotePath,'meetings/Discharge pilot.md');
 assert.equal(fm2.media_uri,'MediaArchive/2026/04/rec-part-2.m4a');assert.equal(fm2.meeting_label,'job/northern-health');
 assert.deepEqual(fm2.tags.sort(),['job/northern-health','meeting']);assert.deepEqual(fm2.attendees,['Sam']);
 assert.equal(new Date(fm2.end).toISOString(),new Date('2026-04-08T11:00:00').toISOString());assert.equal(fm2.weekly_note,'2026-W15');
 assert.equal(progress[0],'Reading transcript…');
});

test('a failure before the note is touched removes the new files',{skip:!hasAf},async()=>{
 const {MeetingSplitService}=await loadService();
 const {app}=makeVault();
 await app.vault.create('t.json',JSON.stringify({segments:[{start:0,end:1,text:'a'},{start:3,end:4,text:'b'}]}));
 await app.vault.create('m.md','---\ntitle: m\ntranscript_uri: t.json\nstart_date: 2026-04-08\nstart_time: "10:00"\n---\nbody\n');
 const plugin={app,settings:{meetingTemplateEnabled:true}};
 app.vault.create=(orig=>async(p,d)=>{if(p.endsWith('.md'))throw Error('disk full');return orig(p,d);})(app.vault.create);
 await assert.rejects(new MeetingSplitService(plugin).split({file:app.vault.getAbstractFileByPath('m.md'),audioPath:null,transcriptPath:'t.json',splitSec:2,firstTitle:'m',secondTitle:'n',copyLabelAndAttendees:false,trashOriginals:true}),/disk full/);
 assert.deepEqual([...app.vault.files.keys()].sort(),['m.md','t.json']);
});
