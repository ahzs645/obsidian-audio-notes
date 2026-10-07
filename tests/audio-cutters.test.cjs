// Round-trips real files through macOS's afconvert/afinfo; skipped elsewhere.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript'),{execFileSync}=require('node:child_process');
const mods={};
const load=file=>{if(mods[file])return mods[file];const mod={exports:{}};const req=name=>name==='./Mp4AudioCutter'?load('src/audio/Mp4AudioCutter.ts'):require(name);
 new Function('exports','module','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod.exports,mod,req);return mods[file]=mod.exports;};
const hasAf=(()=>{try{execFileSync('which',['afconvert']);return true;}catch{return false;}})();
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aan-cut-'));
function fixture(ext,args){
 // 6 s of a 440 Hz tone, 16-bit mono 48 kHz WAV, converted to the target format.
 const rate=48000,n=rate*6,wav=Buffer.alloc(44+n*2);
 wav.write('RIFF',0);wav.writeUInt32LE(36+n*2,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*12000),44+i*2);
 const src=path.join(dir,'tone.wav'),out=path.join(dir,`tone.${ext}`);fs.writeFileSync(src,wav);execFileSync('afconvert',[...args,src,out]);
 return new Uint8Array(fs.readFileSync(out));
}
const seconds=file=>Number(/estimated duration: ([\d.]+)/.exec(execFileSync('afinfo',[file]).toString())[1]);
function check(ext,parts,expectFirst){
 const files=['first','second'].map(k=>{const f=path.join(dir,`${k}.${ext}`);fs.writeFileSync(f,parts[k]);return f;});
 const [a,b]=files.map(seconds);
 assert.ok(Math.abs(a-expectFirst)<0.05,`first part ${a}s`);assert.ok(Math.abs(a+b-6)<0.1,`total ${a+b}s`);
 for(const f of files)execFileSync('afconvert',['-f','WAVE','-d','LEI16',f,f+'.wav']); // decodes cleanly
}
test('M4A splits losslessly at a frame boundary',{skip:!hasAf},()=>{
 const {splitMp4Audio,readSampleTable}=load('src/audio/Mp4AudioCutter.ts');
 const m4a=fixture('m4a',['-f','m4af','-d','aac']);
 const parts=splitMp4Audio(m4a,2.5);
 assert.ok(Math.abs(parts.splitSec-2.5)<0.03);
 const total=readSampleTable(m4a).sizes.length;
 assert.equal(readSampleTable(parts.first).sizes.length+readSampleTable(parts.second).sizes.length,total);
 check('m4a',parts,2.5);
});
test('LPCM CAF splits by byte range',{skip:!hasAf},()=>{
 const {splitCafAudio}=load('src/audio/CafAudioCutter.ts');
 const parts=splitCafAudio(fixture('caf',['-f','caff','-d','LEF32']),2);
 assert.equal(parts.splitSec,2);check('caf',parts,2);
});
test('compressed CAF and non-MP4 input are rejected so callers can fall back',{skip:!hasAf},()=>{
 const {splitCafAudio}=load('src/audio/CafAudioCutter.ts');const {splitMp4Audio}=load('src/audio/Mp4AudioCutter.ts');
 assert.throws(()=>splitCafAudio(fixture('caf',['-f','caff','-d','aac']),2),/can't be cut losslessly/);
 assert.throws(()=>splitMp4Audio(new Uint8Array(64),1));
});
