import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real HTTP and process-restart verification. The image/geometry are explicitly
// synthetic; this command never calls an external provider or touches user data.
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pocketrecall-smoke-'));
const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
let child, base, checks = 0;
async function stop() {
  if (!child || child.exitCode != null) return;
  const current = child;
  await new Promise(resolve => {
    const timeout = setTimeout(() => current.kill('SIGKILL'), 3000);
    current.once('exit', () => { clearTimeout(timeout); resolve(); });
    current.kill('SIGTERM');
  });
  child = null;
}
async function start() {
  const source = `import {createAppServer} from './server.mjs';
    const disabled={configured:false,model:'smoke-test'};
    const server=createAppServer({dataDir:process.argv[1],vision:disabled,runVision:disabled,reconstruction:disabled});
    server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  child = spawn(process.execPath, ['--input-type=module', '-e', source, dataDir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Smoke-test server did not start within 5 seconds.')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Smoke-test server exited (${code}).`)); });
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(output.trim()).port); } catch (error) { reject(error); } }
    });
  });
  base = `http://127.0.0.1:${port}`;
}
async function request(route, body) {
  const response = await fetch(`${base}/api/run/${route}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`); checks++;
  return response.json();
}
try {
  await start();
  const page = await fetch(`${base}/run`); assert.equal(page.status, 200); checks++;
  const initial = await request('state'); const sessionId = initial.session.id;
  for (const [index, videoTime] of [0, 9, 15].entries()) await request('frame', { sessionId, seq: index + 1, videoTime, imageDataUrl });
  const found = await request('query', { sessionId, text: 'Find my keys' });
  assert.equal(found.state.objects[0].latestCheck.status, 'not_seen');
  assert.equal(found.state.guidance.confirmed, false); checks++;
  await request('query', { sessionId, text: 'Got it' });
  const before = await request('export');
  const evidenceUrl = found.state.objects[0].evidenceUrl;
  const evidenceBefore = Buffer.from(await (await fetch(base + evidenceUrl)).arrayBuffer());
  const history = await request('history/keys'); assert.equal(history.observations.length, 3); checks++;
  const other = await request('session', { mode: 'video', filename: 'another-recording.mp4' });
  const archive = await request('sessions'); assert.equal(archive.sessions.length, 2); checks++;
  await request('session/open', { sessionId });
  const forbidden = await fetch(`${base}/api/run/session/open`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' }, body: JSON.stringify({ sessionId: other.session.id }) });
  assert.equal(forbidden.status, 403); checks++;
  await stop(); await start();
  const restored = await request('state'); assert.equal(restored.session.id, sessionId); checks++;
  const after = await request('export');
  assert.deepEqual(after.memory, before.memory); checks++;
  assert.deepEqual(after.maps.map(m => [m.id, m.revision.sha256, m.points]), before.maps.map(m => [m.id, m.revision.sha256, m.points])); checks++;
  const evidenceAfter = Buffer.from(await (await fetch(base + evidenceUrl)).arrayBuffer());
  assert.deepEqual(evidenceAfter, evidenceBefore); checks++;
  const search = await request('search', { sessionId, text: 'keys' }); assert.equal(search.results.length, 1); checks++;
  console.log(JSON.stringify({ passed: true, checks, transport: 'real HTTP', restart: 'new server process', input: 'synthetic fixture', restoredObservations: after.memory.observations.length, restoredMaps: after.maps.length }, null, 2));
} finally { await stop(); await rm(dataDir, { recursive: true, force: true }); }
