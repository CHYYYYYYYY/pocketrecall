import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunSession } from '../lib/run-session.mjs';
import { MemoryAgent } from '../lib/memory-agent.mjs';
const image='data:image/jpeg;base64,'+fs.readFileSync(new URL('../public/assets/demo-poster.jpg',import.meta.url)).toString('base64');
async function setup(t,planner) {
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-agent-'));
 const run=new RunSession({dataDir,fixturePath:new URL('../public/assets/demo-manifest.json',import.meta.url)});
 t.after(()=>{run.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 for(const [seq,videoTime] of [[1,0],[2,9],[3,15]]) await run.ingest({sessionId:run.session.id,seq,videoTime,imageDataUrl:image});
 return {run,agent:new MemoryAgent(run,{planner}),ask:text=>({sessionId:run.session.id,text})};
}
test('agent retrieves durable evidence, explains history and sequences departure through explicit tools',async t=>{
 const {run,agent,ask}=await setup(t);
 const found=await agent.handle(ask('Where are my keys?'));
 assert.equal(found.state.targetId,'keys');assert.equal(found.agent.provider,'rules');
 assert.equal(found.agent.evidence[0].observationId,run.state().objects[0].lastSeen.id);
 assert.ok(found.agent.toolCalls.some(c=>c.tool==='memory.search'));
 assert.ok(found.agent.toolCalls.some(c=>c.tool==='guidance.start'));
 const history=await agent.handle(ask('Where were my keys before?'));
 assert.equal(history.kind,'history');assert.ok(history.agent.evidence.length>=2);
 assert.match(history.message,/earlier|sighting|recorded/i);
 const departing=await agent.handle(ask("I'm heading out"));assert.equal(departing.kind,'departure');
 const confirmed=await agent.handle(ask('Got it'));assert.equal(confirmed.confirmedBy,'user_report');
 assert.equal(run.session.agentTurns.length,4);
});
test('agent asks for clarification on ambiguous names and refuses nonexistent model targets',async t=>{
 const {run,agent,ask}=await setup(t,{configured:true,plan:async()=>({action:'find',entityId:'invented',query:''})});
 const answer=await agent.handle(ask('keys or wallet?'));assert.equal(answer.kind,'clarify');assert.equal(run.session.targetId,null);
 const invalid=await agent.handle(ask('the thing I misplaced'));assert.equal(invalid.kind,'clarify');assert.equal(run.session.targetId,null);
});
test('language model can choose tools but cannot fabricate positions or speak unsupported claims',async t=>{
 const {run,agent,ask}=await setup(t,{configured:true,plan:async()=>({action:'find',entityId:'keys',query:'',position:[999,999,999],message:'I know you have it'})});
 const answer=await agent.handle(ask('help with the metal thing I use to unlock the door'));
 assert.equal(answer.agent.provider,'gemini');assert.equal(answer.state.targetId,'keys');
 assert.deepEqual(answer.agent.evidence[0].position,run.state().objects[0].lastSeen.position);
 assert.doesNotMatch(answer.message,/999|know you have/);
});
test('session changes cancel pending agent plans before tools execute',async t=>{
 let finish;
 const {run,agent,ask}=await setup(t,{configured:true,plan:()=>new Promise(resolve=>finish=resolve)});
 const pending=agent.handle(ask('the metal thing I misplaced'));
 run.start({mode:'video'});finish({action:'find',entityId:'keys',query:''});
 await assert.rejects(pending,/session/i);
 assert.equal(run.session.targetId,null);assert.equal(run.session.agentTurns,undefined);
});
