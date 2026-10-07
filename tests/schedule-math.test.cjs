const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const mod={exports:{}};
new Function('exports','module',ts.transpileModule(fs.readFileSync('src/schedule-math.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod.exports,mod);
const S=mod.exports;
const f=(startDate,startTime,endDate,endTime)=>({startDate,startTime,endDate,endTime});

test('moving the start keeps the meeting length',()=>{
 assert.deepEqual(S.moveStart(f('2026-04-08','11:30','2026-04-08','12:00'),{startTime:'12:00'}),f('2026-04-08','12:00','2026-04-08','12:30'));
});
test('moving the start date carries the end date with it',()=>{
 assert.deepEqual(S.moveStart(f('2026-04-08','10:04','2026-04-08','10:34'),{startDate:'2026-04-10'}),f('2026-04-10','10:04','2026-04-10','10:34'));
});
test('a late start pushes the end past midnight instead of before the start',()=>{
 assert.deepEqual(S.moveStart(f('2026-04-08','11:00','2026-04-08','12:00'),{startTime:'23:30'}),f('2026-04-08','23:30','2026-04-09','00:30'));
});
test('an invalid existing length falls back to an hour',()=>{
 assert.deepEqual(S.moveStart(f('2026-04-08','12:00','2026-04-08','01:00'),{startTime:'13:00'}),f('2026-04-08','13:00','2026-04-08','14:00'));
});
test('seconds from imported recordings survive a shift',()=>{
 assert.deepEqual(S.moveStart(f('2025-12-03','11:04:48','2025-12-03','11:34:20'),{startTime:'12:00'}),f('2025-12-03','12:00','2025-12-03','12:29:32'));
});
test('same-day end follows the start date; multi-day keeps its own',()=>{
 assert.equal(S.setEnd(f('2026-04-08','09:00','2026-04-07','10:00'),{endTime:'10:30'},false).endDate,'2026-04-08');
 assert.equal(S.setEnd(f('2026-04-08','22:00','2026-04-09','01:00'),{endTime:'02:00'},true).endDate,'2026-04-09');
});
test('validation catches an end before the start',()=>{
 assert.equal(S.validateSchedule(f('2026-04-08','12:00','2026-04-08','01:00')),'The meeting ends before it starts.');
 assert.equal(S.validateSchedule(f('2026-04-08','12:00','2026-04-08','12:30')),null);
});
test('length presets and formatting',()=>{
 assert.deepEqual(S.setLengthMinutes(f('2026-04-08','12:00','2026-04-08','12:10'),90),f('2026-04-08','12:00','2026-04-08','13:30'));
 assert.equal(S.formatLength(46*60000),'46m');assert.equal(S.formatLength(90*60000),'1h 30m');assert.equal(S.formatLength(-1),'');
});
