import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {RunSession} from '../lib/run-session.mjs';
import {MemoryAgent} from '../lib/memory-agent.mjs';
test('official glass ID 39 persists through the observation gap without future leakage and reacquires at 92s',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-ledger-'));
  const run=new RunSession({dataDir:dir,fixturePath:new URL('../public/assets/demo-manifest.json',import.meta.url)});
  t.after(()=>{run.close();fs.rmSync(dir,{recursive:true,force:true});});
  const initial=run.startLedger();assert.equal(initial.map,null);assert.equal(initial.observationCount,0);
  assert.equal(initial.ledger.source.wineGlassObservations,undefined,'future sightings must not be included in session metadata');
  const sid=run.session.id;let count=0,at40,points40,points0;
  for(const time of initial.ledger.frameTimes.filter(t=>t<=92)){
    const {state}=await run.ingestLedger({sessionId:sid,seq:++count,videoTime:time});
    const glass=state.objects.find(o=>o.id==='ledger_39');
    assert.ok(!glass.lastSeen||glass.lastSeen.semantics.videoTime<=time);
    if(time<16)assert.equal(glass.lastSeen,null);
    if(time===0)points0=state.map.points.length;
    if(time===40){at40=glass.lastSeen;points40=state.map.points.length;}
    if(time===60){assert.equal(glass.lastSeen.id,at40.id);assert.equal(glass.latestCheck.status,'not_seen');}
    if(time===92){assert.equal(glass.lastSeen.semantics.videoTime,92);assert.notEqual(glass.lastSeen.id,at40.id);assert.ok(state.map.points.length>=points40);}
  }
  const answer=await new MemoryAgent(run).handle({sessionId:sid,text:'Find the wine glass'});
  assert.equal(answer.state.targetId,'ledger_39');assert.equal(answer.state.guidance.coordinateUnits,'relative');assert.equal(answer.state.guidance.simulatedUser,true);
  assert.equal(run.state().maps.length,1);assert.ok(points40>points0);
  const loaded=new RunSession({dataDir:dir,fixturePath:new URL('../public/assets/demo-manifest.json',import.meta.url)});t.after(()=>loaded.close());
  assert.equal(loaded.state().objects.find(o=>o.id==='ledger_39').lastSeen.semantics.videoTime,92);
});
