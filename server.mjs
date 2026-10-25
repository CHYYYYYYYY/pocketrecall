import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './lib/memory.mjs';
import { createVisionClient, validateFrameImage, VisionError } from './lib/vision.mjs';
import { RunSession } from './lib/run-session.mjs';
import { MemoryAgent } from './lib/memory-agent.mjs';
import { attachLiveServer } from './lib/live-voice.mjs';
import { createReadStream } from 'node:fs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function loadLocalEnv() {
  const envPath = path.join(ROOT, '.env.local');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new VisionError('Send JSON with Content-Type application/json.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new VisionError('Request exceeds the 6 MB limit.', 413);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new VisionError('Request exceeds the 6 MB limit.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new VisionError('Request body must be valid JSON.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VisionError('Request body must be a JSON object.', 400);
  return body;
}

function validateMetadata(body, state) {
  if (typeof body.sessionId !== 'string' || !Number.isSafeInteger(body.generation)
    || !Number.isSafeInteger(body.seq) || body.seq < 1
    || typeof body.capturedAt !== 'string' || !Number.isFinite(Date.parse(body.capturedAt))) {
    throw new VisionError('Valid sessionId, generation, positive seq, and capturedAt are required.', 400);
  }
  if (Date.parse(body.capturedAt) > Date.now() + 60000) throw new VisionError('Capture timestamp is in the future. Check the device clock.', 400);
  if (body.sessionId !== state.session.id || body.generation !== state.session.generation) throw new VisionError('This observation belongs to an expired session.', 409);
  if (state.session.observerState === 'paused') throw new VisionError('Observation is paused.', 409);
}

export function createAppServer({
  dataDir = path.join(ROOT, '.pocketrecall-data'),
  publicDir = path.join(ROOT, 'public'),
  store = new MemoryStore({ dataDir }),
  vision = createVisionClient(),
  runVision,
  reconstruction,
  liveOptions,
} = {}) {
  const run = new RunSession({ dataDir: path.join(dataDir, 'run'), fixturePath: path.join(ROOT, 'public', 'assets', 'demo-manifest.json'), ...(runVision ? { vision: runVision } : {}), ...(reconstruction ? { reconstruction } : {}) });
  const agent = new MemoryAgent(run);
  let inFlight = null;
  const cancelObservation = () => {
    if (inFlight) inFlight.controller.abort();
    inFlight = null;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    try {
      const host = req.headers.host || '';
      let base;
      try { base = new URL(`http://${host}`); } catch { throw new VisionError('Invalid host.', 400); }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new VisionError('This demo only accepts localhost requests.', 403);
      const url = new URL(req.url, base);
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== base.origin) throw new VisionError('Cross-origin changes are not allowed.', 403);
      if (req.method === 'GET' && url.pathname === '/api/run/config') return sendJson(res, 200, { ...run.config(), live });
      if (req.method === 'GET' && url.pathname === '/api/run/state') return sendJson(res, 200, run.state());
      if (req.method === 'GET' && url.pathname === '/api/run/sessions') return sendJson(res, 200, run.listSessions());
      if (req.method === 'GET' && url.pathname === '/api/run/reconstruction') return sendJson(res, 200, await run.poll());
      if (req.method === 'GET' && url.pathname === '/api/run/export') return sendJson(res, 200, run.export());
      if (req.method === 'GET' && url.pathname === '/api/run/maps') return sendJson(res, 200, { maps: run.pipeline.store.snapshot().maps });
      if (req.method === 'GET' && url.pathname.startsWith('/api/run/map/')) return sendJson(res, 200, run.map(decodeURIComponent(url.pathname.slice('/api/run/map/'.length)), url.searchParams.get('revision') || undefined));
      if (req.method === 'GET' && url.pathname.startsWith('/api/run/history/')) return sendJson(res, 200, { observations: run.pipeline.store.history(decodeURIComponent(url.pathname.slice('/api/run/history/'.length))) });
      if (req.method === 'GET' && url.pathname.startsWith('/api/run/evidence/')) {
        const parts = url.pathname.split('/');
        if (parts.length !== 6) throw new VisionError('Evidence not found.', 404);
        const evidence = run.evidence(parts[4], parts[5]);
        res.writeHead(200, { 'content-type': evidence.endsWith('.png') ? 'image/png' : 'image/jpeg', 'cache-control': 'no-store' });
        return res.end(await readFile(evidence));
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(res, 200, { provider: 'gemini', configured: vision.configured, model: vision.model });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, store.getState());
      if (req.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/evidence/'.length));
        if (!/^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg)$/.test(id)) throw new VisionError('Evidence not found.', 404);
        const evidencePath = store.evidencePath(id);
        if (!evidencePath) throw new VisionError('Evidence not found.', 404);
        const bytes = await readFile(evidencePath);
        res.writeHead(200, { 'content-type': MIME[path.extname(evidencePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(bytes);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = await readJson(req);
        if (url.pathname === '/api/run/session') return sendJson(res, 200, run.start(body));
        if (url.pathname === '/api/run/ledger') return sendJson(res, 200, run.startLedger());
        if (url.pathname === '/api/run/ledger/frame') return sendJson(res, 200, await run.ingestLedger(body));
        if (url.pathname === '/api/run/review') return sendJson(res, 200, run.startReview(body));
        if (url.pathname === '/api/run/review/frame') return sendJson(res, 200, await run.ingestReview(body));
        if (url.pathname === '/api/run/session/open') return sendJson(res, 200, run.openSession(body));
        if (url.pathname === '/api/run/recording') return sendJson(res, 200, run.importRecording(body));
        if (url.pathname === '/api/run/search') return sendJson(res, 200, run.search(body));
        if (url.pathname === '/api/run/frame') return sendJson(res, 200, await run.ingest(body));
        if (url.pathname === '/api/run/geometry') return sendJson(res, 200, run.attachGeometry(body));
        if (url.pathname === '/api/run/pose') return sendJson(res, 200, run.updatePose(body));
        if (url.pathname === '/api/run/query') return sendJson(res, 200, run.query(body));
        if (url.pathname === '/api/run/agent') return sendJson(res, 200, await agent.handle(body));
        if (url.pathname === '/api/run/register') return sendJson(res, 200, run.register(body));
        if (url.pathname === '/api/run/move') return sendJson(res, 200, run.move(body));
        if (url.pathname === '/api/run/reconstruct') return sendJson(res, 200, await run.build(body));
        if (url.pathname === '/api/session') {
          if (!['demo', 'live'].includes(body.mode)) throw new VisionError('Session mode must be demo or live.', 400);
          cancelObservation();
          return sendJson(res, 200, store.startSession({ mode: body.mode }));
        }
        if (url.pathname === '/api/control') {
          if (!['pause', 'resume', 'clear'].includes(body.action)) throw new VisionError('Unknown control action.', 400);
          cancelObservation();
          return sendJson(res, 200, store.control(body.action));
        }
        if (url.pathname === '/api/calibration') {
          cancelObservation();
          return sendJson(res, 200, store.setCalibration(body.points));
        }
        if (url.pathname === '/api/query') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) throw new VisionError('A question of 1–1000 characters is required.', 400);
          const result = store.query(body.text);
          if (result.kind === 'control') cancelObservation();
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/demo/observe') {
          const state = store.getState();
          if (state.session.mode !== 'demo') throw new VisionError('Demo observations are disabled in live camera mode.', 409);
          validateMetadata(body, state);
          validateFrameImage(body.evidenceDataUrl);
          return sendJson(res, 200, store.applyObservation({ ...body, source: 'demo' }));
        }
        if (url.pathname === '/api/observe') {
          const state = store.getState();
          if (state.session.mode !== 'live') throw new VisionError('Start a live camera session before observing.', 409);
          validateMetadata(body, state);
          validateFrameImage(body.imageDataUrl);
          if (!vision.configured) throw new VisionError('Gemini is not configured. Add GEMINI_API_KEY to .env.local and restart the server.', 503);
          if (inFlight) throw new VisionError('A frame is already being analyzed. Skip this frame and try the next one.', 429);
          const task = { controller: new AbortController(), sessionId: body.sessionId, generation: body.generation };
          inFlight = task;
          try {
            const result = await vision.analyzeFrame(body.imageDataUrl, { signal: task.controller.signal });
            const applied = store.applyObservation({
              sessionId: body.sessionId, generation: body.generation, seq: body.seq,
              capturedAt: body.capturedAt, items: result.items,
              evidenceDataUrl: body.imageDataUrl, source: 'live',
            });
            return sendJson(res, 200, { ...applied, usage: result.usage });
          } catch (error) {
            const current = store.getState();
            if (!task.controller.signal.aborted && current.session.id === task.sessionId && current.session.generation === task.generation) store.control('interrupted');
            throw error;
          } finally {
            if (inFlight === task) inFlight = null;
          }
        }
        throw new VisionError('API route not found.', 404);
      }
      if (url.pathname.startsWith('/api/')) throw new VisionError('API route not found.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new VisionError('Method not allowed.', 405);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new VisionError('Invalid path.', 400); }
      const relative = ['/run', '/run/'].includes(pathname) || (pathname === '/' && existsSync(path.join(publicDir, 'run.html'))) ? 'run.html' : ['/', '/desk'].includes(pathname) ? 'index.html' : pathname.slice(1);
      if (relative.split('/').some(part => part.startsWith('.') || part.includes('\\'))) throw new VisionError('File not found.', 404);
      const target = path.resolve(publicDir, relative);
      if (!target.startsWith(`${path.resolve(publicDir)}${path.sep}`)) throw new VisionError('File not found.', 404);
      const info = await stat(target);
      if (!info.isFile()) throw new VisionError('File not found.', 404);
      if (['.mp4', '.webm'].includes(path.extname(target))) {
        const mime = target.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
        const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
        res.writeHead(match ? 206 : 200, { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(match ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}) });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
      const bytes = await readFile(target);
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const status = error instanceof VisionError ? error.status : error?.code === 'ENOENT' ? 404 : 400;
      const message = error instanceof VisionError ? error.message
        : error?.code === 'ENOENT' ? 'File not found.'
          : error?.code ? 'Local storage could not complete the request.'
            : String(error?.message || 'The request could not be completed.').slice(0, 250);
      sendJson(res, status, { error: message });
    }
  });
  const live = attachLiveServer(server, { run, agent, ...liveOptions });
  server.on('close', cancelObservation);
  server.on('close', () => run.close());
  server.store = store;
  server.run = run;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createAppServer();
  server.listen(port, '127.0.0.1', () => console.log(`PocketRecall running at http://localhost:${port}`));
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another port.` : `PocketRecall could not start its local server (${error.code || 'unknown error'}).`);
    process.exitCode = 1;
  });
}
