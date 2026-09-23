const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function fixture() {
 const context = {exports: {}, console, require(name) {
  if (name === 'obsidian') return {Platform: {isDesktop:true}, normalizePath:x=>x};
  if (name === './AiModelCatalog') return {AiModelCatalog: class {}, effortOptions:(models,model,selected)=>{
   if(!model) return [{value:'',label:'Provider default'}];
   const known=models.find(m=>m.value===model||m.resolvedModel===model);
   return [{value:'',label:'Provider default'},...(known?known.efforts:selected?[selected]:[]).map(v=>({value:v,label:v}))];
  }};
  return require(name);
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/services/MeetingAiService.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, context);
 return new context.exports.MeetingAiService({app:{vault:{adapter:{}}},manifest:{dir:'test'},register(){}});
}
test('different meetings run concurrently; duplicate jobs remain blocked across rename', async()=>{
 const service=fixture(), pending=new Map(), states=[];
 const a={path:'a.md'},b={path:'b.md'};
 service.generateMeetingNotesJob=file=>new Promise(resolve=>pending.set(file,resolve));
 const unsubscribe=service.subscribeGeneration(()=>states.push([service.isGenerating(a),service.isGenerating(b)]));
 const first=service.generateMeetingNotes(a,'A'),second=service.generateMeetingNotes(b,'B');
 assert.equal(pending.size,2);
 await assert.rejects(service.generateMeetingNotes({path:'a.md'},'duplicate'),/already/);
 a.path='renamed.md';
 await assert.rejects(service.generateMeetingNotes(a,'duplicate'),/already/);
 pending.get(a)({}); await first;
 assert.equal(service.isGenerating(a),false); assert.equal(service.isGenerating(b),true);
 pending.get(b)({}); await second;
 assert.deepEqual(states,[[true,false],[true,true],[false,true],[false,false]]);
 unsubscribe();
});
test('failed generation releases its meeting for retry', async()=>{
 const service=fixture(),file={path:'a.md'};
 service.generateMeetingNotesJob=async()=>{throw Error('failed');};
 await assert.rejects(service.generateMeetingNotes(file,'A'),/failed/);
 assert.equal(service.isGenerating(file),false);
 service.generateMeetingNotesJob=async()=>({markdownNotes:'done'});
 assert.equal((await service.generateMeetingNotes(file,'A')).markdownNotes,'done');
});
test('running jobs preserve settings getters and captured model while another meeting changes settings',async()=>{
 const service=fixture();
 class Settings {constructor(){this.model='first';} get meetingAiCodexModel(){return this.model;} get meetingAiCodexEffort(){return 'high';} get meetingAiPrompt(){return 'Summarize';} get meetingAiCustomInstructions(){return '';}}
 service.plugin.settings=new Settings();
 service.models={get:()=>({models:[{value:'first',label:'first',efforts:['high']},{value:'second',label:'second',efforts:['high']}]})};
 let resume,seen;
 service.resolveProvider=()=>({label:'Test',checkHealth:()=>new Promise(r=>resume=()=>r({available:true})),generateJson:async(settings,prompt,schema,choice)=>{seen=[choice.model,choice.effort];return {title:'',markdown_notes:'Notes'};}});
 service.plugin.app.vault.read=async()=>'';
 service.plugin.app.vault.modify=async()=>{};
 const job=service.generateMeetingNotes({path:'a.md',basename:'A'},'transcript');
 service.plugin.settings.model='second';resume();await job;
 assert.deepEqual(seen,['first','high']);
});
test('a model the CLI no longer offers falls back to the first available at its default effort',async()=>{
 const service=fixture(),warnings=[],warn=console.warn;console.warn=m=>warnings.push(m);
 const catalog=[{value:'gpt-6',label:'GPT-6',efforts:['low','high']},{value:'gpt-5.4',label:'GPT-5.4',efforts:['xhigh']}];
 const settings=(model,effort)=>({meetingAiProvider:'codex',meetingAiCodexBinaryPath:'codex',meetingAiCodexModel:model,meetingAiCodexEffort:effort});
 // The service runs in its own vm realm, so copy its result into this one to compare.
 const choice=(...a)=>({...service.effectiveModelChoice(settings(...a))});
 try {
  service.models={get:()=>({models:catalog})};
  assert.deepEqual(choice('gpt-5.4','xhigh'),{model:'gpt-5.4',effort:'xhigh'},'a listed model is kept as chosen');
  assert.deepEqual(choice('gpt-5.4','low'),{model:'gpt-5.4',effort:''},'an effort that model cannot do drops to the provider default');
  assert.deepEqual(choice('gpt-5.3-withdrawn','xhigh'),{model:'gpt-6',effort:''},'a withdrawn model falls back to the first available');
  assert.equal(warnings.length,1);assert.match(warnings[0],/no longer offers "gpt-5.3-withdrawn"/);
  assert.deepEqual(choice('',''),{model:'',effort:''},'provider default stays the provider default');
  service.models={get:()=>undefined};
  assert.deepEqual(choice('gpt-5.3-withdrawn','xhigh'),{model:'gpt-5.3-withdrawn',effort:'xhigh'},'without a catalog the saved values are trusted');
 } finally { console.warn=warn; }
});
