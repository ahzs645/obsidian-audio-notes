const test=require('node:test'),assert=require('node:assert/strict'),esbuild=require('esbuild');
const stub=new Proxy({moment:require('moment'),normalizePath:p=>p},{get:(t,k)=>k in t?t[k]:class{}});
async function load(){
 const out=await esbuild.build({entryPoints:['src/AudioNotesSettings.ts'],bundle:true,platform:'node',format:'cjs',external:['obsidian','electron'],write:false,logLevel:'error',plugins:[{name:'svelte-stub',setup(b){b.onResolve({filter:/\.svelte$/},a=>({path:a.path,namespace:'sv'}));b.onLoad({filter:/.*/,namespace:'sv'},()=>({contents:'export default class {}',loader:'js'}));}}]});
 const mod={exports:{}};new Function('module','exports','require',out.outputFiles[0].text)(mod,mod.exports,n=>n==='obsidian'?stub:require(n));return mod.exports;
}
test('label display names survive loading and saving settings',async()=>{
 const {AudioNotesSettings}=await load();
 const settings=AudioNotesSettings.fromDefaultSettings();
 settings.meetingLabelCategories=[{id:'r',name:'Research',icon:'',tagPrefix:'Research',labelNames:{'research/uc-davis':'UC Davis'}}];
 assert.deepEqual(settings.meetingLabelCategories[0].labelNames,{'research/uc-davis':'UC Davis'});
 const saved=JSON.parse(JSON.stringify(settings));
 assert.deepEqual(saved._meetingLabelCategories[0].labelNames,{'research/uc-davis':'UC Davis'});
 const reloaded=AudioNotesSettings.overrideDefaultSettings(settings);
 assert.equal(reloaded.meetingLabelCategories[0].labelNames['research/uc-davis'],'UC Davis');
});
