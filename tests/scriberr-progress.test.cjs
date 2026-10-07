const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const mod={exports:{}};
new Function('exports','module','require',ts.transpileModule(fs.readFileSync('src/ScriberrClient.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod.exports,mod,n=>n==='obsidian'?{request:async()=>'',requestUrl:async()=>({})}:require(n));
const {ScriberrClient}=mod.exports;

test('polling reports each job status before finishing',async()=>{
 const client=new ScriberrClient({baseUrl:'http://x',apiKey:'k'});
 const states=['pending','processing','completed'];
 client.fetchQuickJob=async()=>({id:'1',status:states.shift()});
 const seen=[];
 const job=await client.waitForQuickJob('1',{pollIntervalMs:1,onStatus:j=>seen.push(j.status)});
 assert.equal(job.status,'completed');assert.deepEqual(seen,['pending','processing','completed']);
});
test('a failed job surfaces the server message',async()=>{
 const client=new ScriberrClient({baseUrl:'http://x',apiKey:'k'});
 client.fetchQuickJob=async()=>({id:'1',status:'failed',error_message:'model not loaded'});
 await assert.rejects(client.waitForQuickJob('1',{pollIntervalMs:1}),/model not loaded/);
});
