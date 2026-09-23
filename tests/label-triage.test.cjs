const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(write=async()=>{},opts={}) {
 const context={exports:{},console:{error(){}},require(name){
  if(name==='obsidian')return {Modal:class {constructor(){this.contentEl={ownerDocument:{activeElement:null,body:{}}};}},Notice:class{},TFile:class{}};
  if(name==='./meeting-label-manager')return {applyMeetingLabelToFile:write};
  if(name==='./meeting-labels')return {buildMeetingLabelInfo:tag=>({displayName:tag})};
  if(name==='./modals/ConfirmModal')return {confirmWithModal:async(app,o)=>{opts.confirms?.push(o);return opts.confirm!==false;}};
  return {};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/LabelTriageModal.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
 const modal=new context.exports.LabelTriageModal({app:{},meetingAiService:opts.ai});
 modal.updateRowLabel=()=>{};modal.updateSummary=()=>{};modal.updateApplyAllButton=()=>{};
 modal.items=[{file:{path:'a'},title:'A',hasContent:true},{file:{path:'b'},title:'B',hasContent:true}];
 return modal;
}
test('one active label applies to multiple clicked meetings without choosing it again',async()=>{
 const writes=[],m=fixture(async(app,file,tag)=>writes.push([file.path,tag]));m.activeTag='project/one';
 const [a,b]=m.items;assert.equal(await m.applyItem(a),true);assert.equal(await m.applyItem(b),true);
 assert.deepEqual(writes,[['a','project/one'],['b','project/one']]);assert.equal(m.items.length,0);assert.equal(m.activeTag,'project/one');
});
test('in-flight labels are captured and repeated clicks cannot duplicate a write',async()=>{
 let finish;const writes=[],m=fixture(async(app,file,tag)=>{writes.push(tag);await new Promise(r=>finish=r);});
 m.activeTag='first';const a=m.items[0],pending=m.applyItem(a);m.activeTag='second';
 assert.equal(await m.applyItem(a),false);finish();assert.equal(await pending,true);assert.deepEqual(writes,['first']);
});
test('failed saves keep the meeting available for retry; individual mode honors row choice',async()=>{
 let fail=true;const writes=[],m=fixture(async(app,file,tag)=>{if(fail)throw Error('offline');writes.push(tag);});
 const a=m.items[0];m.activeTag='active';m.individualMode=true;a.chosenTag='exception';
 assert.equal(await m.applyItem(a),false);assert.equal(m.items.length,2);assert.equal(m.applying.size,0);
 fail=false;assert.equal(await m.applyItem(a),true);assert.deepEqual(writes,['exception']);
});
test('applyAll writes nothing until the confirmation is accepted',async()=>{
 const confirms=[],writes=[],decline=fixture(async(app,file,tag)=>writes.push(tag),{confirm:false,confirms});
 decline.individualMode=true;decline.items.forEach((i,n)=>{i.chosenTag='t'+n;i.source=n?'manual':'ai';});
 await decline.applyAll();
 assert.deepEqual(writes,[]);assert.equal(decline.items.length,2);
 assert.equal(confirms.length,1);assert.match(confirms[0].message,/2 meeting notes, 1 of them suggested by the AI/);
 const accept=fixture(async(app,file,tag)=>writes.push(tag),{confirm:true,confirms});
 accept.individualMode=true;accept.items.forEach((i,n)=>{i.chosenTag='t'+n;});
 await accept.applyAll();
 assert.deepEqual(writes,['t0','t1']);assert.equal(accept.items.length,0);
});
test('AI suggestions run several at a time and stop on request without losing what landed',async()=>{
 let inFlight=0,peak=0;const release=[];
 const ai={isConfigured:()=>true,async suggestMeetingLabel({title}){
  inFlight+=1;peak=Math.max(peak,inFlight);
  await new Promise(r=>release.push(r));inFlight-=1;return 'tag-'+title;}};
 const m=fixture(async()=>{},{ai});
 m.items=Array.from({length:9},(_,n)=>({file:{path:'p'+n},title:'T'+n,hasContent:true}));
 m.suggestButton={textContent:'',disabled:false,setText(t){this.textContent=t;}};
 m.individualCheckbox={checked:false};m.renderList=()=>{};m.buildAiContext=async()=>'body';
 m.collectCandidateTags=()=>m.items.map(i=>'tag-'+i.title);
 const run=m.suggestAll();
 await new Promise(r=>setImmediate(r));
 assert.equal(peak,3,'three suggestions should be in flight at once');
 release.splice(0).forEach(r=>r());
 await new Promise(r=>setImmediate(r));
 m.cancelSuggest=true;release.splice(0).forEach(r=>r());
 await run;
 const labeled=m.items.filter(i=>i.chosenTag);
 assert.ok(labeled.length>0&&labeled.length<9,`expected a partial run, got ${labeled.length}`);
 assert.ok(labeled.every(i=>i.source==='ai'&&i.chosenTag==='tag-'+i.title));
 assert.equal(m.suggesting,false);assert.equal(m.cancelSuggest,false);
});
