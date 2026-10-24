import { DeskScene, drawDemoFrame } from './scene.js';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state, config, step = 0, seq = 0, stream = null, captureTimer = null, captureBusy = false, operationEpoch = 0;
let selectedObjectId = 'keys', selectedObservationId = null, guidedTimer = null, guidedEpoch = 0;
let calibrating = false, calibrationPoints = [], lastAnswer = '', queryBusy = false;
let recognition = null, voiceEnabled = false, speechPhase = 'idle', voiceErrors = 0, restartTimer = null, speechGeneration = 0;
let toastTimer;
const scene = new DeskScene($('desk-scene'), { onSelect: (id, observationId) => selectObject(id, observationId) });
const icons = { keys: '⚿', wallet: '▱', earbuds: '◉' };
const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function age(time) { const s = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; }
function location(position) { if (!position) return 'No position recorded'; if (state?.calibration && (position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1)) return 'Outside calibrated desk'; const desk = state?.calibration || state?.session.mode === 'demo'; const side = position.x < .34 ? 'left' : position.x > .66 ? 'right' : 'center'; const depth = position.y < .34 ? (desk ? 'Far' : 'Upper') : position.y > .66 ? (desk ? 'Near' : 'Lower') : 'Middle'; return `${depth} ${side} of ${desk ? 'desk' : 'camera view'}`; }
function toast(message, error = false) { $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
async function api(path, body) { const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status})`); error.status = response.status; throw error; } return data; }
function accept(next) { if (!next?.session) return; if (state?.session.id === next.session.id && (next.session.generation < state.session.generation || (next.session.generation === state.session.generation && next.lastProcessedSeq < state.lastProcessedSeq))) return; state = next; seq = Math.max(seq, (state.lastProcessedSeq ?? 0) + 1); render(); }
function metadata() { return { sessionId: state.session.id, generation: state.session.generation, seq: ++seq, capturedAt: new Date().toISOString() }; }
function selectObject(id, observationId = null) { selectedObjectId = id; selectedObservationId = observationId; render(); }
function findEvidence() { const observation = state?.observations.find(o => o.id === selectedObservationId); return observation || state?.objects.find(o => o.id === selectedObjectId)?.lastSeen; }

function render() {
  if (!state) return;
  const demo = state.session.mode === 'demo';
  $('demo-mode').classList.toggle('selected', demo); $('live-mode').classList.toggle('selected', !demo);
  $('source-note').innerHTML = demo ? '<span class="amber-dot"></span> Simulated scene · real memory engine' : '<span class="privacy-dot"></span> Camera input · cloud vision · local memory';
  $('demo-controls').hidden = !demo; $('live-controls').hidden = demo;
  $('demo-frame').hidden = !demo; $('camera-video').hidden = demo || !stream;
  $('camera-placeholder').hidden = demo || !!stream;
  $('frame-badge').textContent = demo ? 'SIMULATED DEMO' : 'CAMERA · LAST ANALYSIS BOXES';
  const status = state.session.observerState;
  $('observer-status').textContent = status === 'observing' ? (demo ? 'Demo session' : stream ? 'Observing' : 'Camera needed') : status === 'paused' ? 'Paused' : 'Interrupted';
  $('observer-status').classList.toggle('error', status === 'interrupted');
  $('pause-btn').textContent = status === 'observing' ? 'Pause observation' : 'Resume observation';
  $('coordinate-note').textContent = state.calibration ? 'Calibrated desk plane · height not measured' : demo ? 'Synthetic desk coordinates · illustrative objects' : 'Uncalibrated camera coordinates · calibrate for desk positions';
  $('map-description').textContent = selectedObservationId ? 'Selected historical observation' : 'Last observed positions';
  const evidence = findEvidence();
  scene.setState(state, { selectedObjectId, selectedObservationId });
  $('object-grid').innerHTML = state.objects.map(object => {
    const seen = object.lastSeen; const current = object.latestCheck?.status === 'seen';
    return `<button class="object-card ${selectedObjectId === object.id ? 'selected' : ''}" data-object="${object.id}"><span class="object-icon">${icons[object.id]}</span><span class="object-info"><strong>${escapeHTML(object.name)}</strong><p>${seen ? escapeHTML(location(seen.position)) : 'No confirmed sighting yet'}</p></span><span class="object-meta"><b class="${!current ? 'unseen' : ''}">${seen ? current ? '● Recently seen' : '◌ Last seen' : '— Not recorded'}</b>${seen ? age(seen.capturedAt) : 'Waiting for evidence'}</span></button>`;
  }).join('');
  const events = [...state.events].reverse().slice(0, 20);
  $('event-count').textContent = `${state.events.length} events`;
  $('timeline').innerHTML = events.length ? events.map(event => {
    const name = state.objects.find(o => o.id === event.objectId)?.name || event.objectId;
    const titles = { first_seen: `${name} entered memory`, position_changed: `${name}: a new observed position`, moved: `${name}: a new observed position`, not_seen: `${name} was not seen in this check`, disappeared: `${name} was not seen in this check`, reappeared: `${name} was seen again`, unclear: `${name}: image could not confirm` };
    return `<button class="timeline-row ${selectedObservationId === event.observationId ? 'selected' : ''}" data-observation="${event.observationId || ''}" data-object="${event.objectId}"><span class="timeline-time">${clock(event.capturedAt)}</span><span class="timeline-dot"></span><span class="timeline-detail">${escapeHTML(titles[event.type] || `${name} · ${event.type.replaceAll('_', ' ')}`)}<small>${event.source === 'demo' ? 'Simulated input' : 'Camera evidence'}${event.to ? ' · ' + escapeHTML(location(event.to)) : ''}</small></span><span class="timeline-arrow">↗</span></button>`;
  }).join('') : '<p class="empty-state">Your observations will appear here.</p>';
  if (evidence?.evidenceId) {
    $('evidence-img').hidden = false; $('evidence-empty').hidden = true;
    const src = `/api/evidence/${encodeURIComponent(evidence.evidenceId)}`;
    if ($('evidence-img').getAttribute('src') !== src) $('evidence-img').src = src;
    $('evidence-kind').textContent = evidence.source === 'demo' ? 'SIMULATED EVIDENCE' : 'CAMERA EVIDENCE';
    const object = state.objects.find(o => o.id === (evidence.objectId || selectedObjectId));
    $('evidence-title').textContent = `${object?.name || 'Object'} · ${evidence.status && evidence.status !== 'seen' ? 'Observation check' : 'Last confirmed sighting'}`;
    $('evidence-meta').textContent = `${clock(evidence.capturedAt)} · ${age(evidence.capturedAt)}. ${evidence.position ? location(evidence.position) + '.' : 'Object not confirmed in this frame.'}`;
  } else {
    $('evidence-img').hidden = true; $('evidence-empty').hidden = false; $('evidence-img').removeAttribute('src');
    $('evidence-kind').textContent = 'No evidence'; $('evidence-title').textContent = 'No confirmed sighting.'; $('evidence-meta').textContent = 'Unknown objects stay unknown. A position needs an observation.';
  }
  if (state.lastProcessedCapturedAt) $('capture-status').textContent = `Last analyzed ${clock(state.lastProcessedCapturedAt)}`;
  else $('capture-status').textContent = demo ? 'Ready for the next scene' : 'Waiting for a camera observation';
  drawOverlay();
}

function drawOverlay() {
  const canvas = $('overlay-canvas'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (calibrating) {
    calibrationPoints.forEach((p, i) => { ctx.fillStyle = '#d6f78b'; ctx.beginPath(); ctx.arc(p.x * canvas.width, p.y * canvas.height, 10, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#1b2921'; ctx.font = 'bold 14px sans-serif'; ctx.fillText(String(i + 1), p.x * canvas.width - 4, p.y * canvas.height + 5); });
    return;
  }
  for (const object of state?.objects || []) {
    if (object.latestCheck?.status !== 'seen' || !object.lastSeen?.bbox) continue;
    const [x1, y1, x2, y2] = object.lastSeen.bbox, x = x1 * canvas.width, y = y1 * canvas.height;
    ctx.strokeStyle = object.id === selectedObjectId ? '#d6f78b' : '#b9d2b1'; ctx.lineWidth = 2; ctx.strokeRect(x, y, (x2 - x1) * canvas.width, (y2 - y1) * canvas.height);
    ctx.font = '16px sans-serif'; const width = ctx.measureText(object.name).width + 14; ctx.fillStyle = '#17291fe0'; ctx.fillRect(x, Math.max(0, y - 25), width, 24); ctx.fillStyle = '#e8f2d9'; ctx.fillText(object.name, x + 7, Math.max(18, y - 8));
  }
}

async function demoStep(nextStep) {
  if (state.session.mode !== 'demo') return;
  const epoch = operationEpoch; step = nextStep;
  if (state.session.observerState !== 'observing') accept(await api('/api/control', { action: 'resume' }));
  if (epoch !== operationEpoch) return;
  const frame = drawDemoFrame($('demo-frame'), step);
  $('demo-steps').querySelectorAll('span').forEach((el, i) => el.classList.toggle('on', i <= step));
  const result = await api('/api/demo/observe', { ...metadata(), items: frame.items, evidenceDataUrl: frame.imageDataUrl });
  if (epoch !== operationEpoch) return;
  accept(result.state); selectedObservationId = null; render();
}
function stopGuided() { guidedEpoch++; clearTimeout(guidedTimer); guidedTimer = null; $('guided-btn').textContent = '▶ Run guided demo'; }
async function runGuided() {
  if (guidedTimer) { stopGuided(); return; }
  await switchMode('demo');
  const epoch = ++guidedEpoch; $('guided-btn').textContent = '■ Stop demo';
  let next = 1;
  const advance = async () => {
    if (epoch !== guidedEpoch) return;
    try { await demoStep(next++); if (epoch !== guidedEpoch) return; if (next <= 2) guidedTimer = setTimeout(advance, 2300); else { guidedTimer = null; $('guided-btn').textContent = '↺ Replay demo'; await ask('Where are my keys?'); } } catch (error) { stopGuided(); toast(error.message, true); }
  };
  guidedTimer = setTimeout(advance, 2300);
}

function stopCamera() { clearTimeout(captureTimer); captureTimer = null; stream?.getTracks().forEach(track => track.stop()); stream = null; $('camera-video').srcObject = null; }
async function switchMode(mode) {
  const epoch = ++operationEpoch; stopGuided(); stopCamera(); calibrationPoints = []; calibrating = false; $('calibration-note').hidden = true; $('camera-stage').classList.remove('calibrating'); $('calibrate-btn').textContent = '⌗ Calibrate desk';
  speechGeneration++; window.speechSynthesis?.cancel(); speechPhase = voiceEnabled ? 'listening' : 'idle'; voiceStatus(); restartRecognition();
  selectedObservationId = null; seq = 0;
  const next = await api('/api/session', { mode }); if (epoch !== operationEpoch) return; accept(next);
  $('answer-text').textContent = mode === 'demo' ? 'This sandbox uses simulated images and real memory logic. Move the keys, cover them, then ask.' : 'Live session ready. Connect a camera to begin observing.';
  if (mode === 'demo') await demoStep(0);
}
async function connectCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera access needs localhost or HTTPS and a supported browser.', true);
  try {
    if (state.session.mode !== 'live') await switchMode('live');
    else if (stream) { toast('Camera is already connected. Start a fresh session if you move it.'); return; }
    // A reconnect could have a different camera pose; do not reuse old coordinates.
    else if (state.observations.length) { operationEpoch++; seq = 0; selectedObservationId = null; accept(await api('/api/session', { mode: 'live' })); }
    const epoch = operationEpoch;
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 800 }, facingMode: 'environment' }, audio: false });
    if (epoch !== operationEpoch) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired; $('camera-video').srcObject = stream; await $('camera-video').play();
    stream.getVideoTracks()[0].addEventListener('ended', () => { stopCamera(); api('/api/control', { action: 'pause' }).then(accept).catch(() => {}); toast('Camera disconnected. Historical evidence is still available.', true); });
    if (state.session.observerState !== 'observing') accept(await api('/api/control', { action: 'resume' }));
    render();
    config = await api('/api/config'); updateConfig();
    if (!config.configured) { toast('Camera connected. Add GEMINI_API_KEY to .env.local and restart to enable analysis.'); return; }
    toast('Camera connected. Calibrate the desk for reliable desk-relative positions.'); scheduleCapture(200);
  } catch (error) { toast(`Camera: ${error.message}`, true); render(); }
}
function scheduleCapture(delay = 3000) { clearTimeout(captureTimer); if (stream && state?.session.mode === 'live' && state.session.observerState !== 'paused') captureTimer = setTimeout(capture, delay); }
async function capture() {
  if (captureBusy || !stream || calibrating || state.session.mode !== 'live' || state.session.observerState === 'paused') { scheduleCapture(); return; }
  if (!config?.configured) return toast('Live analysis needs a Gemini key. Open Setup for the local configuration.', true);
  const video = $('camera-video'); if (!video.videoWidth) { scheduleCapture(); return; }
  const epoch = operationEpoch; captureBusy = true; $('capture-status').textContent = 'Analyzing a new frame…';
  const canvas = document.createElement('canvas'); canvas.width = Math.min(video.videoWidth, 1280); canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth); canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  let retryDelay = 3000;
  try {
    const result = await api('/api/observe', { ...metadata(), imageDataUrl: canvas.toDataURL('image/jpeg', .82) });
    if (epoch === operationEpoch) accept(result.state);
  } catch (error) {
    if (epoch === operationEpoch) { if (error.status !== 409) toast(error.message, true); try { accept(await api('/api/state')); } catch {} retryDelay = error.status === 429 ? 10000 : 6000; }
  } finally { captureBusy = false; if (epoch === operationEpoch) scheduleCapture(retryDelay); }
}

function voiceStatus() {
  $('voice-btn').textContent = voiceEnabled ? '■ Disable voice' : '♬ Enable voice';
  $('voice-light').classList.toggle('active', voiceEnabled); $('voice-orb').classList.toggle('listening', voiceEnabled && speechPhase === 'listening');
  $('voice-sub').textContent = speechPhase === 'speaking' ? 'Speaking · listening resumes automatically' : voiceEnabled ? speechPhase === 'processing' ? 'Finding the evidence…' : 'Listening · say “Where are my keys?”' : 'Your voice is the interface.';
}
function restartRecognition(delay = 300) {
  clearTimeout(restartTimer); if (!voiceEnabled || !recognition || speechPhase !== 'listening') return;
  restartTimer = setTimeout(() => { if (!voiceEnabled || speechPhase !== 'listening') return; try { recognition.start(); } catch (error) { if (error.name !== 'InvalidStateError') toast(error.message, true); } }, delay);
}
function disableVoice() { voiceEnabled = false; clearTimeout(restartTimer); recognition?.abort(); speechGeneration++; window.speechSynthesis?.cancel(); speechPhase = 'idle'; voiceStatus(); }
function toggleVoice() {
  if (voiceEnabled) return disableVoice();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return toast('This browser does not support speech recognition. Use Chrome. Text controls remain available for testing.', true);
  recognition = new Recognition(); recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = false;
  recognition.onresult = event => { let text = ''; for (let i = event.resultIndex; i < event.results.length; i++) if (event.results[i].isFinal) text += event.results[i][0].transcript; if (text.trim() && speechPhase === 'listening') { voiceErrors = 0; ask(text.trim()); } };
  recognition.onend = () => restartRecognition();
  recognition.onerror = event => { if (event.error === 'aborted' || event.error === 'no-speech') return; voiceErrors++; if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error) || voiceErrors >= 3) { disableVoice(); toast(`Voice recognition unavailable (${event.error}). Check microphone permission and network, then enable it again.`, true); } };
  voiceErrors = 0; voiceEnabled = true; speechPhase = 'listening'; voiceStatus(); restartRecognition(0);
}
function speak(text) {
  if (!window.speechSynthesis) { speechPhase = voiceEnabled ? 'listening' : 'idle'; voiceStatus(); restartRecognition(); return; }
  const generation = ++speechGeneration;
  speechPhase = 'speaking'; clearTimeout(restartTimer); recognition?.abort(); window.speechSynthesis.cancel(); voiceStatus();
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'; utterance.rate = 1.02;
  const voices = window.speechSynthesis.getVoices(); utterance.voice = voices.find(v => v.lang === utterance.lang && v.localService) || voices.find(v => v.lang === utterance.lang) || null;
  const done = () => { if (generation !== speechGeneration) return; speechPhase = voiceEnabled ? 'listening' : 'idle'; voiceStatus(); restartRecognition(350); };
  utterance.onend = done; utterance.onerror = done; window.speechSynthesis.speak(utterance);
}
async function ask(text) {
  if (queryBusy || !text.trim()) return; queryBusy = true; speechPhase = 'processing'; recognition?.abort(); clearTimeout(restartTimer); voiceStatus();
  const epoch = operationEpoch;
  $('voice-prompt').textContent = `“${text}”`;
  try {
    const answer = await api('/api/query', { text }); if (epoch !== operationEpoch) return; lastAnswer = answer.answer;
    $('answer-text').textContent = answer.answer; $('repeat-btn').hidden = false;
    if (answer.objectId) { selectedObjectId = answer.objectId; selectedObservationId = answer.observationId || null; }
    const next = await api('/api/state'); if (epoch !== operationEpoch) return; accept(next);
    if (state.session.observerState === 'paused') clearTimeout(captureTimer); else scheduleCapture();
    speak(answer.answer);
  } catch (error) { toast(error.message, true); speechPhase = voiceEnabled ? 'listening' : 'idle'; voiceStatus(); restartRecognition(); }
  finally { queryBusy = false; if (epoch !== operationEpoch) { speechPhase = voiceEnabled ? 'listening' : 'idle'; voiceStatus(); restartRecognition(); } }
}
function updateConfig() { $('provider-status').textContent = config.configured ? `Gemini ready · ${config.model}` : 'Gemini key not connected'; }

$('demo-mode').onclick = () => switchMode('demo').catch(error => toast(error.message, true));
$('live-mode').onclick = () => switchMode('live').catch(error => toast(error.message, true));
$('camera-btn').onclick = connectCamera; $('guided-btn').onclick = () => runGuided().catch(error => toast(error.message, true));
$('step-btn').onclick = async () => { stopGuided(); $('step-btn').disabled = true; try { await demoStep((step + 1) % 5); } catch (error) { toast(error.message, true); } finally { $('step-btn').disabled = false; } };
$('clear-btn').onclick = async () => { operationEpoch++; stopGuided(); speechGeneration++; window.speechSynthesis?.cancel(); lastAnswer = ''; $('repeat-btn').hidden = true; speechPhase = voiceEnabled ? 'listening' : 'idle'; voiceStatus(); restartRecognition(); clearTimeout(captureTimer); try { selectedObservationId = null; seq = 0; accept(await api('/api/control', { action: 'clear' })); $('answer-text').textContent = 'Session cleared. No item positions are remembered.'; toast('Session and evidence cleared.'); if (state.session.mode === 'live') scheduleCapture(); } catch (error) { toast(error.message, true); } };
$('pause-btn').onclick = async () => { try { accept(await api('/api/control', { action: state.session.observerState === 'observing' ? 'pause' : 'resume' })); if (state.session.observerState === 'paused') clearTimeout(captureTimer); else scheduleCapture(0); } catch (error) { toast(error.message, true); } };
$('capture-btn').onclick = capture; $('voice-btn').onclick = toggleVoice; $('repeat-btn').onclick = () => speak(lastAnswer);
$('query-form').onsubmit = event => { event.preventDefault(); const text = $('query-input').value; $('query-input').value = ''; ask(text); };
document.querySelectorAll('[data-question]').forEach(button => button.onclick = () => ask(button.dataset.question));
$('object-grid').onclick = event => { const button = event.target.closest('[data-object]'); if (button) selectObject(button.dataset.object); };
$('timeline').onclick = event => { const button = event.target.closest('[data-observation]'); if (button) selectObject(button.dataset.object, button.dataset.observation); };
$('setup-btn').onclick = () => $('setup-dialog').showModal(); $('close-setup').onclick = $('done-setup').onclick = () => $('setup-dialog').close();
$('calibrate-btn').onclick = () => { if (state.session.mode === 'live' && !stream) return toast('Connect a camera first.', true); calibrating = !calibrating; calibrationPoints = []; $('calibration-note').hidden = !calibrating; $('camera-stage').classList.toggle('calibrating', calibrating); $('calibrate-btn').textContent = calibrating ? 'Cancel calibration' : '⌗ Calibrate desk'; drawOverlay(); };
$('overlay-canvas').onclick = async event => {
  if (!calibrating) return;
  const rect = event.currentTarget.getBoundingClientRect(); calibrationPoints.push({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }); drawOverlay();
  if (calibrationPoints.length === 4) {
    try { accept(await api('/api/calibration', { points: calibrationPoints })); toast('Desk calibrated. Keep the camera fixed; start a new session after moving it.'); }
    catch (error) { toast(error.message, true); }
    calibrating = false; $('calibration-note').hidden = true; $('camera-stage').classList.remove('calibrating'); $('calibrate-btn').textContent = '⌗ Calibrate desk'; render(); scheduleCapture();
  }
};
window.addEventListener('beforeunload', () => { stopCamera(); disableVoice(); stopGuided(); scene.destroy(); });
setInterval(() => { if (state) render(); }, 1000);
async function initialize() {
  try {
    [config, state] = await Promise.all([api('/api/config'), api('/api/state')]); updateConfig(); accept(state);
    if (state.session.mode === 'demo') {
      if (!state.observations.length) await demoStep(0);
      else {
        const keys = state.objects.find(o => o.id === 'keys'), wallet = state.objects.find(o => o.id === 'wallet');
        step = keys.latestCheck?.status === 'not_seen' ? (wallet.lastSeen?.bbox?.[0] < .65 ? 3 : 2) : keys.lastSeen?.bbox?.[0] > .5 ? 1 : 0;
        const source = state.observations.at(-1);
        const epoch = operationEpoch, image = new Image();
        image.onload = () => { if (epoch !== operationEpoch) return; const canvas = $('demo-frame'); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); drawOverlay(); };
        image.onerror = () => toast('The last source image could not be loaded. Start a new demo scene.', true);
        image.src = `/api/evidence/${encodeURIComponent(source.evidenceId)}`;
        $('demo-steps').querySelectorAll('span').forEach((el, i) => el.classList.toggle('on', i <= step)); render();
      }
    }
  } catch (error) { toast(`Could not connect to the local server: ${error.message}`, true); $('provider-status').textContent = 'Local server unavailable'; }
}
initialize();
