const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const load=file=>{const mod={exports:{}};new Function('exports','module',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod.exports,mod);return mod.exports;};
const M=load('src/MeetingSplit.ts');
const seg=(start,end,text,words)=>({id:start,start,end,text,speakerId:'A',...(words?{words}:{})});

test('segments on each side stay whole and the second part is rebased to zero',()=>{
 const {first,second}=M.splitSegments([seg(0,10,'one'),seg(12,20,'two'),seg(100,110,'three')],50);
 assert.deepEqual(first.map(s=>s.text),['one','two']);
 assert.deepEqual(second.map(s=>[s.start,s.end,s.text,s.speakerId]),[[50,60,'three','A']]);
});
test('a straddling segment is divided by its word timings',()=>{
 const words=[{text:' Thanks',start:40,end:41},{text:' bye.',start:41,end:42},{text:' Hello',start:52,end:53},{text:' all.',start:53,end:54}];
 const {first,second}=M.splitSegments([seg(40,54,'Thanks bye. Hello all.',words)],50);
 assert.equal(first[0].text,'Thanks bye.');assert.equal(first[0].end,42);
 assert.equal(second[0].text,'Hello all.');assert.equal(second[0].start,2);assert.deepEqual(second[0].words.map(w=>w.start),[2,3]);
});
test('without words a straddling segment goes where most of it falls',()=>{
 assert.equal(M.splitSegments([seg(40,48,'mostly before')],46).first.length,1);
 assert.equal(M.splitSegments([seg(40,48,'mostly after')],42).second[0].start,0);
});
test('suggestions are the longest mid-recording pauses',()=>{
 const s=[seg(0,100,'a'),seg(130,600,'b'),seg(900,1500,'c'),seg(1500,1530,'d'),seg(1600,1700,'e')];
 const got=M.suggestSplitPoints(s);
 assert.deepEqual(got.map(g=>[g.atSec,g.gapSec]),[[750,300],[1565,70],[115,30]]);
 assert.deepEqual(M.suggestSplitPoints([seg(0,30,'a'),seg(80,90,'b')]),[]);
});
test('split before a line lands in the pause before it',()=>{
 const s=[seg(0,10,'a'),seg(20,30,'b'),seg(30,40,'c')];
 assert.equal(M.splitPointBefore(s,1),15);assert.equal(M.splitPointBefore(s,2),30);
});
test('schedule: part two inherits the end, or the recording length when the end is stale',()=>{
 const start=new Date('2026-04-08T10:00:00'),end=new Date('2026-04-08T11:30:00');
 const a=M.splitSchedule(start,end,45*60,90*60);
 assert.equal(a.first.end.toISOString(),new Date('2026-04-08T10:45:00').toISOString());
 assert.equal(a.second.end.toISOString(),end.toISOString());
 const b=M.splitSchedule(start,new Date('2026-04-08T10:30:00'),45*60,90*60);
 assert.equal(b.second.end.toISOString(),new Date('2026-04-08T11:30:00').toISOString());
});
test('clock formatting',()=>{assert.equal(M.formatClock(65),'1:05');assert.equal(M.formatClock(3725),'1:02:05');});
