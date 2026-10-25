import { SpatialMap } from './run-map.js';
import { Feedback } from './run-feedback.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const video = $('feed');
const capture = document.createElement('canvas'); capture.width = capture.height = 518;
const captureContext = capture.getContext('2d', { alpha: false });
let state, config, processing = false, running = false, timer, pollTimer, seq = 0, epoch = 0, sourceFile = null, sourceUrl = '/assets/demo-first-person.mp4';
let boxes = [], boxesTime = -1, lastProcessed = -1, toastTimer, queryBusy = false, moveBusy = false, recognition, listening = false;
let invisible = false, listenWanted = false, listenTimer = null, aligningFrame = false;
const map = new SpatialMap($('space-map'), objectId => { const object = state?.objects.find(o => o.id === objectId); if (object) ask(`Find my ${object.label}`); });
const feedback = new Feedback(() => { for (const id of ['haptic-tile', 'voice-orb']) { $(id).classList.remove('pulsing'); void $(id).offsetWidth; $(id).classList.add('pulsing'); } });
feedback.onSpeechStart = () => { feedback.listening = false; recognition?.abort(); if (invisible) { $('voice-orb').classList.add('speaking'); $('invisible-status').textContent = 'Speaking'; } };
feedback.onSpeechEnd = () => { $('voice-orb').classList.remove('speaking'); resumeListening(); };
function resumeListening() { clearTimeout(listenTimer); if (invisible && listenWanted && !queryBusy && !feedback.speaking && !document.hidden) listenTimer = setTimeout(() => { if (!listening && !feedback.speaking && !queryBusy) microphone(); }, 400); }

function toast(message, persist = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; if (!persist) toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
async function api(route, body) {
  const response = await fetch(`/api/run/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let result; try { result = await response.json(); } catch { throw new Error('The local service is unavailable. Check that npm start is running.'); }
  if (!response.ok) { const error = new Error(result.error || 'That did not go through. Please try again.'); error.status = response.status; throw error; }
  return result;
}
function time(n) { n = Number.isFinite(n) ? n : 0; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`; }
function setStage(name) { document.querySelectorAll('.pipeline-step').forEach(el => el.classList.toggle('active', el.dataset.step === name)); }
function updateControls() {
  $('play-button').innerHTML = running ? '<span aria-hidden="true">Ⅱ</span>' : '<svg><use href="#i-play"/></svg>';
  $('play-button').setAttribute('aria-label', running ? 'Pause observation' : 'Play and observe');
  $('stream-status').innerHTML = `<i></i> ${running ? 'OBSERVING' : 'PAUSED'}`;
  $('stream-status').classList.toggle('running', running);
  $('observe-label').textContent = running ? 'Watching & remembering' : state?.frameCount ? 'Paused. Your memory is saved.' : 'Press play to start remembering';
}
function pause() { running = false; clearTimeout(timer); video.pause(); updateControls(); }
async function play() {
  if (running) return pause();
  if (video.ended || video.currentTime >= (video.duration || 24) - .1) await restart();
  if (state.session.mode === 'video' && !config.vision.configured) { toast('Connect Gemini to recognize your video, or import its spatial data. The desk demo is ready to try.'); return; }
  try { await video.play(); running = true; updateControls(); observeLoop(); }
  catch { toast('The video is not ready. Try a browser-playable MP4 or WebM.'); }
}
async function observeLoop() {
  if (!running) return;
  try { if (state.session.mode === 'recording') await processRecordingFrame(); else await processFrame(); }
  catch (error) { if (![409, 429].includes(error.status)) { toast(error.message, true); pause(); } }
  if (running) timer = setTimeout(observeLoop, state.session.mode === 'recording' ? 100 : config.frameIntervalMs || 1500);
}
async function seekFrame(videoTime) {
  if (Math.abs(video.currentTime - videoTime) < .001 && !video.seeking) return;
  await new Promise((resolve, reject) => {
    let timeout;
    const finish = () => { clearTimeout(timeout); video.removeEventListener('seeked', done); video.removeEventListener('error', failed); };
    const done = () => { finish(); resolve(); }, failed = () => { finish(); reject(new Error('Could not seek to this annotated frame. Check that the video can play.')); };
    video.addEventListener('seeked', done, { once: true }); video.addEventListener('error', failed, { once: true });
    timeout = setTimeout(failed, 5000); video.currentTime = videoTime;
  });
}
async function processRecordingFrame() {
  if (processing || aligningFrame || video.readyState < 2) return;
  const nextTime = state.recording?.frameTimes.find(t => t > lastProcessed + .0001);
  if (nextTime == null || video.currentTime + .0001 < nextTime) return;
  const generation = epoch; aligningFrame = true; video.pause();
  try {
    await seekFrame(nextTime);
    if (generation !== epoch) return;
    await processFrame(nextTime);
  } finally {
    if (generation === epoch) { aligningFrame = false; if (running) await video.play(); }
  }
}
async function processFrame(annotatedTime) {
  if (!state || processing || video.readyState < 2 || video.seeking || video.currentTime <= lastProcessed + .0001) return;
  const generation = epoch, isRecording = state.session.mode === 'recording';
  const videoTime = isRecording ? annotatedTime ?? state.recording?.frameTimes.find(t => Math.abs(t - video.currentTime) < .001) : video.currentTime;
  if (!Number.isFinite(videoTime) || videoTime <= lastProcessed || (isRecording && Math.abs(video.currentTime - videoTime) > .02)) return;
  const side = Math.max(video.videoWidth, video.videoHeight), scale = 518 / side;
  captureContext.fillStyle = '#000'; captureContext.fillRect(0, 0, 518, 518);
  captureContext.drawImage(video, (518 - video.videoWidth * scale) / 2, (518 - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
  let imageDataUrl;
  try { imageDataUrl = capture.toDataURL('image/jpeg', .83); }
  catch { throw new Error('This video blocks frame capture. Download it, then choose Use your video.'); }
  processing = true; setStage('detect'); $('latency').textContent = 'ANALYZING…'; $('stage-detect').textContent = isRecording ? 'Reading this frame’s annotation' : state.session.mode === 'demo' ? 'Reading the simulated scene' : 'Recognizing objects';
  const sessionId = state.session.id;
  try {
    const result = await api('frame', { sessionId, seq: ++seq, videoTime, imageDataUrl });
    if (epoch !== generation) return;
    lastProcessed = videoTime; boxes = result.detections; boxesTime = videoTime;
    render(result.state); $('latency').textContent = `${result.elapsedMs} ms · ${isRecording ? 'ANNOTATION' : state.session.mode === 'demo' ? 'FIXTURE' : 'GEMINI'}`;
    $('stage-detect').textContent = `${boxes.filter(b => b.status === 'seen').length} objects in this frame`;
    setStage('store'); drawBoxes();
    if (state.session.mode === 'video' && config.reconstruction.configured && $('auto-map').checked && state.frameCount % 6 === 0 && !['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state.reconstruction?.status)) buildMap();
  } finally { if (epoch === generation) processing = false; }
}
async function loadSource({ mode, url, filename, file = null }) {
  pause(); epoch++; processing = false; aligningFrame = false; boxes = []; boxesTime = -1; lastProcessed = -1; seq = 0; feedback.update(null);
  if (sourceFile && sourceUrl.startsWith('blob:')) URL.revokeObjectURL(sourceUrl);
  sourceFile = file; sourceUrl = url;
  state = await api('session', { mode, filename });
  map.simPose = null; render(state); $('video-error').hidden = true;
  video.crossOrigin = url.startsWith('https:') ? 'anonymous' : null;
  if (!url.startsWith('https:')) video.removeAttribute('crossorigin');
  video.src = url; video.load();
  $('answer').textContent = mode === 'demo' ? 'What are you looking for?' : 'Press play. Gemini will recognize objects from sampled video frames.';
  $('checklist').hidden = true; $('query-input').value = ''; updateControls();
}
async function restart() {
  pause(); epoch++; processing = false; aligningFrame = false; seq = 0; lastProcessed = -1; boxes = []; boxesTime = -1; feedback.update(null);
  state = await api('session', { mode: state.session.mode, filename: state.session.filename });
  video.currentTime = 0; map.simPose = null; render(state); $('answer').textContent = 'A fresh start. Previous server sessions stay saved on this device.';
  if (state.session.mode === 'demo' && video.readyState >= 2) setTimeout(() => processFrame().catch(e => toast(e.message)), 150);
}
async function importRecording(file) {
  if (!sourceFile || !video.videoWidth || !Number.isFinite(video.duration)) throw new Error('Load the matching video first, wait for it to be ready, then import its spatial data.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a spatial data file smaller than 5 MB.');
  let recording; try { recording = JSON.parse(await file.text()); } catch { throw new Error('This spatial data file is not valid JSON.'); }
  pause(); epoch++; processing = false; aligningFrame = false;
  const generation = epoch;
  const next = await api('recording', { sessionId: state.session.id, recording, video: { name: sourceFile.name, duration: video.duration, width: video.videoWidth, height: video.videoHeight } });
  if (generation !== epoch) return;
  seq = 0; lastProcessed = -1; boxes = []; boxesTime = -1; feedback.update(null); map.simPose = null; render(next);
  video.currentTime = 0; $('checklist').hidden = true;
  $('answer').textContent = 'Spatial data connected. Press play to build memory from its annotated frames.';
  toast(`${next.recording.source.dataset} connected: ${next.recording.frameTimes.length} annotated frames. The reference map is precomputed; object memory grows during playback.`);
}
function render(next) {
  state = next; const demo = state.session.mode === 'demo', recorded = state.session.mode === 'recording';
  $('session-short').textContent = state.session.id.slice(0, 8).toUpperCase();
  $('mode-badge').textContent = recorded ? 'ANNOTATION REPLAY' : demo ? 'SIMULATED RECORDING' : 'VIDEO / API VISION';
  $('mode-badge').classList.toggle('amber', demo);
  $('source-name').textContent = demo ? 'The desk recording' : state.session.filename;
  $('source-caption').textContent = recorded ? `${state.recording.source.dataset} · Frame-aligned objects, poses and spatial annotations.` : demo ? 'A 24-second simulated scene. Real memory, stored as you watch.' : 'Video plays here. Sampled frames go to Gemini; memory stays on this device.';
  $('feed-source').textContent = recorded ? 'DATASET REPLAY · ANNOTATED' : demo ? 'SIMULATED RECORDING' : 'RECORDED FIRST-PERSON · GEMINI';
  $('frame-number').textContent = `FRAME ${String(state.frameCount).padStart(3, '0')}`;
  $('stage-capture').textContent = `${state.frameCount} frames observed`;
  $('stage-store').textContent = `${state.observationCount} observations saved`;
  $('storage-count').textContent = state.observationCount; $('storage-frames').textContent = state.frameCount;
  $('objects').innerHTML = state.objects.map((object, index) => {
    const icon = { keys: 'key', wallet: 'wallet', earbuds: 'buds', phone: 'phone' }[object.id] || 'cube';
    const last = object.lastSeen, p = last?.position;
    const units = last?.coordinateUnits === 'relative' ? 'rel' : 'm';
    const crop = last?.evidence?.crop;
    const zoom = crop ? Math.min(10, .55 / Math.max(crop[2] - crop[0], crop[3] - crop[1], .01)) : 1;
    const cx = crop ? (crop[0] + crop[2]) / 2 : .5, cy = crop ? (crop[1] + crop[3]) / 2 : .5;
    const thumbnail = last && object.evidenceUrl ? `<img src="${escape(object.evidenceUrl)}" alt="" style="width:${zoom * 100}%;left:${50 - cx * zoom * 100}%;top:50%;transform:translateY(-${cy * 100}%)">` : `<svg><use href="#i-${icon}"/></svg>`;
    return `<button class="object-card ${last ? 'has-memory' : ''} ${object.id === state.targetId ? 'selected' : ''}" data-object="${escape(object.id)}" aria-label="Open the memory of ${escape(object.label)}"><span class="object-thumb">${thumbnail}<span class="object-number">${String(index + 1).padStart(2, '0')}</span></span><b>${escape(object.label)}</b><small>${p ? p.map(n => n.toFixed(2)).join(', ') + ' ' + units : last ? 'IMAGE SAVED' : 'NO SIGHTING YET'}</small><span class="object-state">${last ? object.latestCheck?.status === 'not_seen' ? 'Last seen · out of view' : p ? 'Position remembered' : 'Image remembered' : 'Waiting for a first look'}</span></button>`;
  }).join('');
  $('objects').querySelectorAll('[data-object]').forEach(button => button.addEventListener('click', () => inspectObject(button.dataset.object)));
  $('events').innerHTML = [...state.events].reverse().slice(0, 14).map(event => `<li><time>${escape(new Date(event.at).toLocaleTimeString('en-GB', { hour12: false }))}</time><span>${escape(event.text)}</span></li>`).join('') || '<li><time>—</time><span>Press play. The first memory starts with a look.</span></li>';
  $('event-status').textContent = state.events.length ? `${state.events.length} EVENTS` : 'IDLE';
  $('map-empty').hidden = Boolean(state.map);
  $('point-count').textContent = `${(state.map?.points.length || 0).toLocaleString()} POINTS`;
  $('map-source').textContent = recorded ? 'PRECOMPUTED REFERENCE' : demo ? 'SIMULATED SPACE' : state.map ? 'VGGT / RELATIVE SCALE' : 'NO MAP YET';
  $('map-status').textContent = state.map ? `${state.map.frameCount} frames aligned · ${state.objects.filter(o => o.lastSeen?.mapId === state.map.id && o.lastSeen.position).length} placed objects` : 'Waiting for a first look';
  $('map-note').textContent = recorded ? `Precomputed reference · ${state.map?.units === 'meters' ? 'dataset meters' : 'relative coordinates'} · memory follows playback` : demo ? 'Video, depth and camera poses are simulated' : 'Keyframe reconstruction · relative scale, not meters';
  $('stage-map').textContent = state.map ? recorded ? 'Dataset coordinates' : demo ? 'Simulated pose + depth' : 'VGGT relative coordinates' : 'Image saved; no position yet';
  $('build-map').disabled = recorded || demo || ['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state.reconstruction?.status);
  $('auto-map').disabled = recorded || demo || !config?.reconstruction.configured;
  $('build-map').textContent = recorded ? 'Reference loaded' : demo ? 'Demo map ready' : state.reconstruction?.status === 'completed' ? 'Update 3D' : ['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state.reconstruction?.status) ? 'Building 3D…' : 'Build 3D';
  $('storage-engine').textContent = state.storage?.preview ? state.storage.durable ? 'Saved in this browser' : 'This tab only' : 'Saved on this device';
  $('memory-proof').textContent = state.map ? `${state.map.id} · ${(state.maps?.find(m => m.id === state.map.id)?.revisions.length || 1)} map versions · ${state.poseCount} camera poses` : 'Every remembered place starts with an image.';
  map.setState(state); renderGuidance(state.guidance);
}
function renderGuidance(guidance) {
  feedback.update(guidance);
  const active = guidance?.status === 'direction';
  $('direction-orb').classList.toggle('aligned', Boolean(guidance?.aligned));
  $('voice-orb').classList.toggle('aligned', Boolean(guidance?.aligned));
  $('direction-arrow').style.transform = `rotate(${active ? guidance.bearingDeg : 0}deg)`;
  $('direction-label').textContent = active ? guidance.aligned ? 'ALIGNED' : `${Math.round(Math.abs(guidance.bearingDeg))}° ${guidance.bearingDeg > 0 ? 'RIGHT' : 'LEFT'}` : 'READY';
  $('distance').textContent = active ? (guidance.distanceM ?? guidance.distanceRelative).toFixed(2) : '—';
  $('distance-unit').textContent = active ? guidance.coordinateUnits === 'meters' ? 'm / simulated distance' : 'relative units / unscaled' : 'No position yet';
  $('guide-target').textContent = guidance ? `${guidance.label || ''} / LAST SEEN` : 'A WAY BACK';
  $('voice-feedback').textContent = active ? guidance.aligned ? 'On course' : 'Turn toward it' : 'Waiting';
  $('haptic-feedback').textContent = guidance?.aligned ? 'Aligned · tap' : typeof navigator.vibrate === 'function' ? 'Tap when aligned' : 'Screen simulation';
  $('pulse-feedback').textContent = feedback.enabled && active ? `Pulse · ${(1000 / guidance.pulse.intervalMs).toFixed(1)} Hz` : 'Sound off';
  $('volume-bar').style.width = active ? `${guidance.pulse.gain / .45 * 100}%` : '0%';
  $('stage-recall').textContent = guidance?.videoConfirmed ? 'Seen again in the recording' : guidance ? active ? 'Voice · touch · pulse' : 'Looking up the last image' : 'Waiting for a request';
  if (guidance?.videoConfirmed) $('voice-feedback').textContent = 'Seen again in video';
  document.querySelectorAll('[data-move]').forEach(b => b.disabled = !active);
  $('invisible-confirm').disabled = !state?.targetId;
}
function drawBoxes() {
  const canvas = $('detections'), r = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const w = r.width, h = r.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  if (!video.videoWidth || Math.abs(video.currentTime - boxesTime) > 1.7) return;
  const side = Math.max(video.videoWidth, video.videoHeight), scale = Math.min(w / video.videoWidth, h / video.videoHeight);
  const ox = (w - video.videoWidth * scale) / 2 - (side - video.videoWidth) / 2 * scale, oy = (h - video.videoHeight * scale) / 2 - (side - video.videoHeight) / 2 * scale;
  for (const detection of boxes.filter(d => d.status === 'seen')) {
    const b = detection.bbox, x = b[0] * side * scale + ox, y = b[1] * side * scale + oy, bw = (b[2] - b[0]) * side * scale, bh = (b[3] - b[1]) * side * scale;
    ctx.strokeStyle = '#f0ab7c'; ctx.lineWidth = 1; ctx.strokeRect(x - 5, y - 5, bw + 10, bh + 10);
    const label = state.objects.find(o => o.id === detection.entityId)?.label || detection.entityId;
    ctx.font = '10px "Helvetica Neue",sans-serif'; const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#f0ab7c'; ctx.fillRect(x - 5, y - 23, tw + 13, 17); ctx.fillStyle = '#302a22'; ctx.fillText(label, x + 1, y - 11);
  }
}
async function ask(text) {
  if (queryBusy || !text.trim()) return;
  queryBusy = true; feedback.listening = false; recognition?.abort();
  try {
    setStage('recall'); $('query-input').value = text;
    const generation = epoch, result = await api('query', { sessionId: state.session.id, text });
    if (generation !== epoch) return;
    render(result.state); map.simPose = null; map.render(); $('answer').textContent = result.message;
    if (result.kind === 'pause') { pause(); feedback.update(null); }
    if (result.kind === 'resume' && !running) play();
    if (invisible) $('invisible-reply').textContent = result.message;
    $('checklist').hidden = !result.checklist;
    $('checklist').innerHTML = result.checklist ? result.checklist.map(o => `<span>${o.confirmedByUser ? '✓' : o.lastSeen ? '◉' : '○'} ${escape(o.label)} · ${o.confirmedByUser ? 'Confirmed by you' : o.lastSeen ? 'Remembered' : 'Not seen'}</span>`).join('') + '<p>A memory cannot tell what you are carrying. Confirm each item.</p>' : '';
    feedback.speak(result.message, true);
  } catch (error) { toast(error.message); } finally { queryBusy = false; resumeListening(); }
}
async function move(action) {
  if (moveBusy || !state?.guidance || state.guidance.status !== 'direction') return;
  moveBusy = true;
  try {
    const generation = epoch, result = await api('move', { sessionId: state.session.id, action });
    if (generation !== epoch) return;
    state.guidance = result.guidance; map.setPose(result.pose); renderGuidance(result.guidance); $('answer').textContent = result.guidance.instruction; if (invisible) $('invisible-reply').textContent = result.guidance.instruction; feedback.speak(result.guidance.instruction);
  } catch (error) { toast(error.message); } finally { moveBusy = false; }
}
function dialog(title, html) { $('detail-title').textContent = title; $('detail-body').innerHTML = html; if (!$('detail-dialog').open) $('detail-dialog').showModal(); }
function inspectObject(objectId) {
  const object = state.objects.find(o => o.id === objectId), last = object.lastSeen;
  const provenance = !last ? 'Not seen yet' : last.evidence.synthetic ? 'Simulated scene / known detections' : last.semantics?.provider === 'dataset_annotation' ? `${last.semantics.dataset} / dataset annotation` : 'Video / Gemini';
  dialog(`${object.label} / memory`, `${last ? `<img src="${escape(object.evidenceUrl)}" alt="${escape(object.label)} — last observed image">` : '<p>No sighting yet. Once the video shows it, its image will appear here.</p>'}<div class="metadata"><div><small>INSTANCE</small><b>${escape(object.id)}</b></div><div><small>SOURCE</small><b>${escape(provenance)}</b></div><div><small>POSITION</small><b>${last?.position ? last.position.map(n => n.toFixed(3)).join(', ') + (last.coordinateUnits === 'relative' ? ' / relative scale' : ' m') : 'No position yet'}</b></div></div><button id="find-detail" class="button light">Find ${escape(object.label)} <svg><use href="#i-arrow"/></svg></button><h3>The saved record</h3><pre>${escape(JSON.stringify({ entity: object.id, lastSeen: last, latestCheck: object.latestCheck }, null, 2))}</pre>`);
  $('find-detail').addEventListener('click', () => { $('detail-dialog').close(); ask(`Find my ${object.label}`); });
}
async function storage() {
  try {
    const result = await api('export');
    const maps = result.memory.maps || [], latest = result.memory.observations.at(-1);
    const storeCopy = result.preview ? 'This preview keeps objects, poses, reference geometry and evidence in your browser. Export the record to keep a copy outside browser storage.' : 'Each sighting connects an object to an image, a moment and a place. Map versions are saved separately. Earlier locations remain available after a restart.';
    dialog('Inside this memory', `<p>${storeCopy}</p><div class="metadata"><div><small>SIGHTINGS</small><b>${result.memory.observations.length}</b></div><div><small>CAMERA POSES</small><b>${result.memory.poses.length}</b></div><div><small>MAP VERSIONS</small><b>${maps.reduce((sum, m) => sum + (m.revisions?.length || 1), 0)}</b></div></div><button id="download-memory" class="button light">Export memory ↓</button><h3>Map index / units, source & revisions</h3><pre>${escape(JSON.stringify(maps.length ? maps : { status: 'waiting_for_spatial_map' }, null, 2))}</pre><h3>The latest sighting</h3><pre>${escape(JSON.stringify(latest || { status: 'waiting_for_observation' }, null, 2))}</pre><h3>How the records connect</h3><pre>${result.preview ? 'browser localStorage → map / observations / poses / evidence' : 'spatial-memory.json → maps → revisions → maps/&lt;sha256&gt;.json\nentity → observation → mapId + poseRef + capturedAt\nevidence/&lt;sha256&gt;.jpg ← observation.evidence\nframes/&lt;frame_id&gt;.json → capture pose + timestamp'}</pre>`);
    $('download-memory').addEventListener('click', () => { const u = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = `pocketrecall-${state.session.id.slice(0, 8)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); });
  } catch (error) { toast(error.message); }
}
function settings() {
  dialog('Connections', `<div class="metadata"><div><small>OBJECT RECOGNITION</small><b>Gemini / ${config.vision.configured ? 'Key configured' : 'Not connected'}</b></div><div><small>3D RECONSTRUCTION</small><b>fal VGGT / ${config.reconstruction.configured ? 'Key configured' : 'Not connected'}</b></div><div><small>HARDWARE</small><b>Browser simulation</b></div></div><p><b>Your video.</b> Gemini recognizes objects from sampled frames. VGGT reconstructs depth and camera poses from batches of keyframes. Its coordinates use relative scale until calibrated.</p><p><b>The desk demo.</b> Video, detections and geometry are simulated; memory storage and retrieval run normally. Imported spatial annotations are replayed as dataset observations.</p><p><b>Connect the services.</b> Set <code>GEMINI_API_KEY</code> and <code>FAL_KEY</code> in the local <code>.env.local</code>, then restart the server. Keys stay on the server. Configured keys still need a successful request to verify access. Current vision model: ${escape(config.vision.model)}.</p><p>Movement controls operate a virtual wearer. Supported devices can vibrate; other devices show the tap on screen. Speech recognition uses your browser’s microphone service.</p><p><a href="https://fal.ai/models/fal-ai/vggt-1b/api" target="_blank" rel="noreferrer">VGGT documentation ↗</a> &nbsp; <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio ↗</a></p>`);
}
async function buildMap() {
  if (!config.reconstruction.configured) { settings(); toast('Connect fal with FAL_KEY to build 3D from video. Gemini provides object recognition.'); return; }
  try { setStage('map'); const generation = epoch, next = await api('reconstruct', { sessionId: state.session.id }); if (generation !== epoch) return; render(next); schedulePoll(); }
  catch (error) { toast(error.message); }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!['IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state?.reconstruction?.status)) return;
  pollTimer = setTimeout(async () => {
    const generation = epoch;
    try { const next = await api('reconstruction'); if (epoch !== generation) return; render(next); if (next.reconstruction?.status === 'completed') toast('Map saved. Choose an object and try finding it.'); else schedulePoll(); }
    catch (error) { toast(error.message); }
  }, 2500);
}
async function microphone() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { listenWanted = false; $('speech-note').textContent = 'Speech recognition is unavailable in this browser. You can type a request.'; $('invisible-status').textContent = 'Voice input is unavailable. Return to the experiment to type.'; $('query-input').focus(); return; }
  if (listening) { listenWanted = false; recognition?.stop(); return; }
  if (recognition || queryBusy) return;
  feedback.cancelSpeech?.(); clearTimeout(listenTimer);
  const current = new Recognition(); recognition = current; current.lang = 'en-US'; current.interimResults = true; current.continuous = false;
  current.onstart = () => { if (recognition !== current) return; listening = true; feedback.listening = true; $('mic-button').classList.add('listening'); $('invisible-listen').textContent = 'Pause listening'; $('speech-note').textContent = 'Listening. Try “Find my keys” or “I’m heading out.”'; if (invisible) { $('invisible-status').textContent = 'I’m listening.'; $('voice-orb').classList.add('listening'); } };
  current.onresult = event => { if (recognition !== current) return; const result = event.results[event.resultIndex]; $('query-input').value = result[0].transcript; if (result.isFinal) ask(result[0].transcript); };
  current.onerror = event => { if (recognition !== current || event.error === 'aborted') return; if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(event.error)) { listenWanted = false; current.unavailable = true; } $('speech-note').textContent = event.error === 'not-allowed' ? 'Microphone access was not granted. You can still type.' : `Voice input stopped (${event.error}). Try again, or type a request.`; if (invisible && !listenWanted) $('invisible-status').textContent = 'Voice input is unavailable. Try again, or return to the experiment.'; };
  current.onend = () => { if (recognition !== current) return; recognition = null; listening = false; feedback.listening = false; $('mic-button').classList.remove('listening'); $('voice-orb').classList.remove('listening'); $('invisible-listen').textContent = 'Start talking'; if (invisible && !listenWanted && !current.unavailable) $('invisible-status').textContent = 'Listening paused. Sound guidance is still on.'; resumeListening(); };
  try { current.start(); } catch { recognition = null; listening = false; feedback.listening = false; listenWanted = false; toast('Voice input could not start. Try again, or type a request.'); }
}

async function enterInvisible() {
  invisible = true; listenWanted = true; $('invisible-view').hidden = false;
  $('app-main').inert = true; $('app-header').inert = true;
  document.body.style.overflow = 'hidden';
  $('exit-invisible').focus();
  try { await feedback.enable(); $('sound-toggle').innerHTML = '<svg><use href="#i-sound"/></svg>Sound on'; $('sound-toggle').setAttribute('aria-pressed', 'true'); feedback.speak('I’m here. What are you looking for?', true); } catch (error) { toast(error.message); }
  if (!running && video.readyState >= 2 && !video.ended) play();
  if (!feedback.speaking) resumeListening();
}
function exitInvisible() { invisible = false; listenWanted = false; feedback.listening = false; clearTimeout(listenTimer); recognition?.abort(); $('invisible-view').hidden = true; $('app-main').inert = false; $('app-header').inert = false; document.body.style.overflow = ''; $('enter-invisible').focus(); }
$('enter-invisible').addEventListener('click', enterInvisible);
$('exit-invisible').addEventListener('click', exitInvisible);
$('invisible-listen').addEventListener('click', () => { listenWanted = true; microphone(); });
$('invisible-confirm').addEventListener('click', () => ask('Got it'));

$('play-button').addEventListener('click', play);
$('restart').addEventListener('click', () => restart().catch(e => toast(e.message)));
$('sample-button').addEventListener('click', () => loadSource({ mode: 'demo', url: '/assets/demo-first-person.mp4', filename: 'The desk recording' }).catch(e => toast(e.message)));
$('public-sample').addEventListener('click', () => loadSource({ mode: 'video', url: 'https://huggingface.co/spaces/facebook/vggt/resolve/main/examples/videos/room.mp4', filename: 'VGGT / room.mp4 — indoor recording' }).then(() => toast('Public sample from facebook/vggt. Press play when loaded. If frame capture is blocked, download the clip and upload it here.')).catch(e => toast(e.message)));
$('upload-button').addEventListener('click', () => $('video-file').click());
$('recording-button').addEventListener('click', () => $('recording-file').click());
$('recording-file').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { await importRecording(file); } catch (error) { toast(error.message, true); } event.target.value = ''; });
$('video-file').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024 * 1024) { toast('Choose a video smaller than 1 GB for this demo.'); return; } try { await loadSource({ mode: 'video', url: URL.createObjectURL(file), filename: file.name, file }); } catch (e) { toast(e.message); } event.target.value = ''; });
$('timeline').addEventListener('input', event => { if (Number.isFinite(video.duration)) video.currentTime = Number(event.target.value); });
video.addEventListener('loadedmetadata', () => { $('timeline').max = video.duration || 24; });
video.addEventListener('loadeddata', () => { $('video-error').hidden = true; if (state?.session.mode === 'demo' && !state.frameCount) processFrame().catch(e => toast(e.message)); });
video.addEventListener('ended', async () => { pause(); try { if (state?.session.mode === 'recording') await processRecordingFrame(); } catch (error) { toast(error.message); return; } toast('Recording finished. Your memory is saved. Try asking for something you saw.'); });
video.addEventListener('error', () => { pause(); $('video-error').hidden = false; $('video-error').textContent = 'This video could not load. Try a local MP4 or WebM, or use the desk demo. The public sample needs access to Hugging Face.'; });
video.addEventListener('timeupdate', () => { $('timeline').value = video.currentTime; $('time-label').textContent = `${time(video.currentTime)} / ${time(video.duration)}`; $('feed-clock').textContent = `${time(video.currentTime)}.${Math.floor(video.currentTime % 1 * 10)}`; drawBoxes(); });
new ResizeObserver(drawBoxes).observe($('video-stage'));
$('query-form').addEventListener('submit', event => { event.preventDefault(); ask($('query-input').value); });
document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => ask(button.dataset.query)));
document.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => move(button.dataset.move)));
window.addEventListener('keydown', event => { if (event.key === 'Escape' && invisible) { exitInvisible(); return; } if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || (!invisible && document.activeElement?.tagName === 'BUTTON') || $('detail-dialog').open || $('add-dialog').open) return; const action = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'forward', w: 'forward', ArrowDown: 'back', s: 'back', q: 'up', e: 'down' }[event.key]; if (action && state?.guidance?.status === 'direction') { event.preventDefault(); move(action); } });
$('sound-toggle').addEventListener('click', async () => { try { if (feedback.enabled) feedback.disable(); else { await feedback.enable(); feedback.speak('Sound guidance is on.', true); } $('sound-toggle').innerHTML = `<svg><use href="#i-sound"/></svg>${feedback.enabled ? 'Sound on' : 'Enable sound'}`; $('sound-toggle').setAttribute('aria-pressed', String(feedback.enabled)); renderGuidance(state.guidance); } catch (error) { toast(error.message); } });
$('mic-button').addEventListener('click', microphone);
$('reset-map').addEventListener('click', () => map.reset());
$('build-map').addEventListener('click', buildMap);
$('inspect-storage').addEventListener('click', storage); $('nav-memory').addEventListener('click', storage);
$('nav-run').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('nav-about').addEventListener('click', () => dialog('A little less lost.', '<p>PocketRecall is an experiment in everyday spatial memory. It remembers where an object last appeared, with an image and a time to back it up.</p><p>Play a first-person recording. Let the memory build. Then ask for something you saw: a short voice prompt gives direction, a light tap marks alignment, and a heartbeat grows as you approach.</p><p>The page is a window into what a pair of glasses could remember. Choose <b>Try it with your eyes up</b> for the screen-free flow. Say <b>“Got it”</b> when you have the object; location alone never confirms possession.</p><p>The built-in scene and wearer are simulated. Uploaded videos use configured vision and reconstruction services, or their own imported spatial annotations.</p>'));
$('open-settings').addEventListener('click', settings);
$('close-detail').addEventListener('click', () => $('detail-dialog').close());
$('add-object').addEventListener('click', () => $('add-dialog').showModal()); $('close-add').addEventListener('click', () => $('add-dialog').close());
$('add-form').addEventListener('submit', async event => { event.preventDefault(); try { render(await api('register', { sessionId: state.session.id, label: $('object-name').value })); $('object-name').value = ''; $('add-dialog').close(); toast('Added. I’ll look for it in the next frame of your uploaded video.'); } catch (e) { toast(e.message); } });
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { document.body.classList.toggle('presentation'); toast('Compact presentation view enabled.'); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); feedback.context?.suspend(); recognition?.abort(); feedback.cancelSpeech?.(); } else { if (feedback.enabled) { feedback.context?.resume(); feedback.schedule(); } resumeListening(); } });
window.addEventListener('pagehide', () => { pause(); feedback.disable(); recognition?.abort(); clearTimeout(pollTimer); if (sourceFile) URL.revokeObjectURL(sourceUrl); });

async function initialize() {
  try {
    [config, state] = await Promise.all([api('config'), api('state')]);
    seq = state.session.lastSeq; lastProcessed = state.session.lastVideoTime; render(state); schedulePoll();
    $('api-status').textContent = `GEMINI ${config.vision.configured ? 'CONFIGURED' : 'OFFLINE'} · VGGT ${config.reconstruction.configured ? 'CONFIGURED' : 'NOT SET'}`;
    if (state.session.mode === 'demo') { video.src = sourceUrl; video.load(); }
    else { $('video-error').hidden = false; $('video-error').textContent = 'Your previous memory is restored and ready to search. Loading another video or the desk demo starts a new session.'; }
    updateControls();
  } catch (error) { $('connection').textContent = 'SERVER OFFLINE'; toast(error.message, true); }
}
initialize();
