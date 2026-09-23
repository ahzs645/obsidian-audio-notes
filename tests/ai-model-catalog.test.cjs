const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const ctx = { exports: {}, require, setTimeout, clearTimeout, AbortController, process, console };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/services/AiModelCatalog.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);
const {parseModels, modelOptions, effortOptions, AiModelCatalog} = ctx.exports;
const plain = value => JSON.parse(JSON.stringify(value));
test('new models and future effort names are discovered without a plugin update', () => {
  const models=parseModels('codex',[{model:'future-model',displayName:'Future',supportedReasoningEfforts:[{reasoningEffort:'ultra'},{reasoningEffort:'new_level'}]}, {model:'hidden',hidden:true}]);
  assert.deepEqual(plain(models[0].efforts),['ultra','new_level']); assert.equal(models.length,1);
  assert.deepEqual(plain(effortOptions(models,'future-model','high').map(x=>x.value)),['','ultra','new_level']);
  assert.equal(modelOptions(models,'legacy').at(-1).value,'legacy');
});
test('Claude aliases and models with no effort support are handled', () => {
  const models=parseModels('claude',[{value:'opus',resolvedModel:'claude-future',displayName:'Opus',supportedEffortLevels:['max']},{value:'haiku'}]);
  assert.deepEqual(plain(effortOptions(models,'claude-future','high').map(x=>x.value)),['','max']);
  assert.deepEqual(plain(effortOptions(models,'haiku','high').map(x=>x.value)),['']);
  assert.throws(()=>parseModels('codex',{})); assert.throws(()=>parseModels('codex',[]));
});
test('refresh is deduplicated, cached, retained offline, and separated by binary and provider', async () => {
  let saved=null,calls=0,offline=false;
  const host={load:async()=>saved,save:async data=>{saved=data;}};
  const discover=async()=>{calls++;if(offline)throw Error('offline');return [{value:'fresh',label:'Fresh',efforts:['high']}];};
  const catalog=new AiModelCatalog(host,discover);
  await Promise.all([catalog.refresh('codex','codex'),catalog.refresh('codex','codex')]);assert.equal(calls,1);
  await catalog.refresh('codex','codex');assert.equal(calls,1);
  offline=true;await catalog.refresh('codex','codex',true);assert.equal(catalog.get('codex','codex').models[0].value,'fresh');assert.match(catalog.status('codex','codex'),/saved model list/);
  const reboot=new AiModelCatalog(host,discover);await reboot.refresh('codex','codex');assert.equal(reboot.get('codex','codex').models[0].value,'fresh');
  assert.equal(reboot.get('claude','codex'),undefined);assert.equal(reboot.get('codex','/other/codex'),undefined);
  catalog.dispose();reboot.dispose();
});

test('CLI discovery handles pagination and Obsidian numeric timer handles', {timeout:2000}, async () => {
  const {EventEmitter}=require('node:events'); const timers=new Map(); let timerId=0, killed=0, pages=0;
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};
  child.stdout.setEncoding=()=>{};child.stdin=new EventEmitter();child.stdin.end=()=>{};
  child.kill=()=>{killed++;queueMicrotask(()=>child.emit('close',0));return true;};
  child.stdin.write=line=>{
    const request=JSON.parse(line);let result;
    if(request.method==='initialize')result={id:request.id,result:{}};
    if(request.method==='model/list'){
      pages++;result={id:request.id,result:{data:[{model:`model-${pages}`,supportedReasoningEfforts:[{reasoningEffort:'max'}]}],nextCursor:pages===1?'next':null}};
    }
    if(result)queueMicrotask(()=>{const line=JSON.stringify(result)+'\n';child.stdout.emit('data',line.slice(0,10));child.stdout.emit('data',line.slice(10));});
  };
  const browser={...ctx,exports:{},require:name=>name==='child_process'?{spawn:()=>child}:require(name),
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,setTimeout(fn,ms));return id;},
    clearTimeout:id=>{clearTimeout(timers.get(id));timers.delete(id);}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/services/AiModelCatalog.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,browser);
  const models=await browser.exports.discoverModels('codex','codex');
  assert.equal(models.length,2);assert.equal(pages,2);assert.equal(killed,1);
  for(const timer of timers.values())clearTimeout(timer);
});
