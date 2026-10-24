import { SpatialMap } from './run-map.js';
import { Feedback } from './run-feedback.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const video = $('feed');
const capture = document.createElement('canvas'); capture.width = capture.height = 518;
const captureContext = capture.getContext('2d', { alpha: false });
let state, config, processing = false, running = false, timer, pollTimer, seq = 0, epoch = 0, sourceFile = null, sourceUrl = '/assets/demo-first-person.mp4';
let boxes = [], boxesTime = -1, lastProcessed = -1, toastTimer, queryBusy = false, moveBusy = false, recognition, listening = false;
const map = new SpatialMap($('space-map'), objectId => { const object = state?.objects.find(o => o.id === objectId); if (object) ask(`帮我找${object.label}`); });
const feedback = new Feedback(() => { $('haptic-tile').classList.remove('pulsing'); void $('haptic-tile').offsetWidth; $('haptic-tile').classList.add('pulsing'); });

function toast(message, persist = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; if (!persist) toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
async function api(route, body) {
  const response = await fetch(`/api/run/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let result; try { result = await response.json(); } catch { throw new Error('本机服务未返回有效响应，请确认 npm start 正在运行。'); }
  if (!response.ok) { const error = new Error(result.error || '操作未完成。'); error.status = response.status; throw error; }
  return result;
}
function time(n) { n = Number.isFinite(n) ? n : 0; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`; }
function setStage(name) { document.querySelectorAll('.pipeline-step').forEach(el => el.classList.toggle('active', el.dataset.step === name)); }
function updateControls() {
  $('play-button').innerHTML = running ? '<span aria-hidden="true">Ⅱ</span>' : '<svg><use href="#i-play"/></svg>';
  $('play-button').setAttribute('aria-label', running ? '暂停观察' : '开始观察视频');
  $('stream-status').innerHTML = `<i></i> ${running ? 'OBSERVING' : 'PAUSED'}`;
  $('stream-status').classList.toggle('running', running);
  $('observe-label').textContent = running ? '取帧 → 识别 → 写入记忆' : state?.frameCount ? '观察已暂停 · 记忆已保留' : '点击播放，开始观察';
}
function pause() { running = false; clearTimeout(timer); video.pause(); updateControls(); }
async function play() {
  if (running) return pause();
  if (video.ended || video.currentTime >= (video.duration || 24) - .1) await restart();
  if (state.session.mode === 'video' && !config.vision.configured) { toast('真实视频识别需要 Gemini 密钥。查看底部「服务状态」；内置模拟录像可立即体验。'); return; }
  try { await video.play(); running = true; updateControls(); observeLoop(); }
  catch { toast('视频尚未加载完成或格式不支持。请使用浏览器可播放的 MP4 / WebM。'); }
}
async function observeLoop() {
  if (!running) return;
  try { await processFrame(); }
  catch (error) { if (![409, 429].includes(error.status)) { toast(error.message, true); pause(); } }
  if (running) timer = setTimeout(observeLoop, config.frameIntervalMs || 1500);
}
async function processFrame() {
  if (!state || processing || video.readyState < 2 || video.seeking || video.currentTime <= lastProcessed + .1) return;
  const generation = epoch, videoTime = video.currentTime;
  const side = Math.max(video.videoWidth, video.videoHeight), scale = 518 / side;
  captureContext.fillStyle = '#000'; captureContext.fillRect(0, 0, 518, 518);
  captureContext.drawImage(video, (518 - video.videoWidth * scale) / 2, (518 - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
  let imageDataUrl;
  try { imageDataUrl = capture.toDataURL('image/jpeg', .83); }
  catch { throw new Error('此公开视频不允许跨站取帧。请下载样片后用「上传第一视角视频」载入。'); }
  processing = true; setStage('detect'); $('latency').textContent = 'ANALYZING…'; $('stage-detect').textContent = state.session.mode === 'demo' ? '读取明确标注的模拟检测' : 'Gemini 正在观察';
  const sessionId = state.session.id;
  try {
    const result = await api('frame', { sessionId, seq: ++seq, videoTime, imageDataUrl });
    if (epoch !== generation) return;
    lastProcessed = videoTime; boxes = result.detections; boxesTime = videoTime;
    render(result.state); $('latency').textContent = `${result.elapsedMs} ms · ${state.session.mode === 'demo' ? 'FIXTURE' : 'GEMINI'}`;
    $('stage-detect').textContent = `${boxes.filter(b => b.status === 'seen').length} 个物体 / 本帧`;
    setStage('store'); drawBoxes();
    if (state.session.mode === 'video' && config.reconstruction.configured && $('auto-map').checked && state.frameCount % 6 === 0 && !['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state.reconstruction?.status)) buildMap();
  } finally { if (epoch === generation) processing = false; }
}
async function loadSource({ mode, url, filename, file = null }) {
  pause(); epoch++; processing = false; boxes = []; boxesTime = -1; lastProcessed = -1; seq = 0; feedback.update(null);
  if (sourceFile && sourceUrl.startsWith('blob:')) URL.revokeObjectURL(sourceUrl);
  sourceFile = file; sourceUrl = url;
  state = await api('session', { mode, filename });
  map.simPose = null; render(state); $('video-error').hidden = true;
  video.crossOrigin = url.startsWith('https:') ? 'anonymous' : null;
  if (!url.startsWith('https:')) video.removeAttribute('crossorigin');
  video.src = url; video.load();
  $('answer').textContent = mode === 'demo' ? '选择一个物体，开始寻找。' : '点击播放后，将抽样帧发送到 Gemini 并保存物体记忆。';
  $('checklist').hidden = true; $('query-input').value = ''; updateControls();
}
async function restart() {
  pause(); epoch++; processing = false; seq = 0; lastProcessed = -1; boxes = []; boxesTime = -1; feedback.update(null);
  state = await api('session', { mode: state.session.mode, filename: state.session.filename });
  video.currentTime = 0; map.simPose = null; render(state); $('answer').textContent = '新会话已就绪。旧会话的证据仍保存在本机。';
  if (state.session.mode === 'demo' && video.readyState >= 2) setTimeout(() => processFrame().catch(e => toast(e.message)), 150);
}
function render(next) {
  state = next; const demo = state.session.mode === 'demo';
  $('session-short').textContent = state.session.id.slice(0, 8).toUpperCase();
  $('mode-badge').textContent = demo ? '合成录像 · 端到端模拟' : '真实视频 · API 识别';
  $('mode-badge').classList.toggle('amber', demo);
  $('source-name').textContent = state.session.filename;
  $('source-caption').textContent = demo ? '合成视频、检测与空间坐标；实际执行记忆存储和查询' : '视频在浏览器回放；抽样帧交给 Gemini，证据保存在本机';
  $('feed-source').textContent = demo ? 'SIMULATED GLASSES · SYNTHETIC' : 'RECORDED FIRST-PERSON · GEMINI';
  $('frame-number').textContent = `FRAME ${String(state.frameCount).padStart(3, '0')}`;
  $('stage-capture').textContent = `${state.frameCount} 帧已处理`;
  $('stage-store').textContent = `${state.observationCount} 条观察已存储`;
  $('storage-count').textContent = state.observationCount; $('storage-frames').textContent = state.frameCount;
  $('objects').innerHTML = state.objects.map(object => {
    const icon = { keys: 'key', wallet: 'wallet', earbuds: 'buds', phone: 'phone' }[object.id] || 'cube';
    const last = object.lastSeen, p = last?.position;
    const units = last?.coordinateUnits === 'relative' ? 'rel' : 'm';
    return `<button class="object-card ${last ? 'has-memory' : ''} ${object.id === state.targetId ? 'selected' : ''}" data-object="${escape(object.id)}" aria-label="查看${escape(object.label)}的记忆"><div class="object-top"><svg><use href="#i-${icon}"/></svg><span class="object-dot"></span></div><b>${escape(object.label)}</b><small>${p ? p.map(n => n.toFixed(2)).join(', ') + ' ' + units : last ? 'IMAGE EVIDENCE' : 'NO MEMORY YET'}</small><span class="object-state">${last ? object.latestCheck?.status === 'not_seen' ? '● 最后位置 · 已离开视野' : p ? '● 已保存空间位置' : '● 已保存图像' : '等待看见'}</span></button>`;
  }).join('');
  $('objects').querySelectorAll('[data-object]').forEach(button => button.addEventListener('click', () => inspectObject(button.dataset.object)));
  $('events').innerHTML = [...state.events].reverse().slice(0, 14).map(event => `<li><time>${escape(new Date(event.at).toLocaleTimeString('en-GB', { hour12: false }))}</time><span>${escape(event.text)}</span></li>`).join('') || '<li><time>—</time><span>开始播放，观察第一件物体。</span></li>';
  $('event-status').textContent = state.events.length ? `${state.events.length} EVENTS` : 'IDLE';
  $('map-empty').hidden = Boolean(state.map);
  $('point-count').textContent = `${(state.map?.points.length || 0).toLocaleString()} POINTS`;
  $('map-source').textContent = demo ? '合成空间 · 已知几何' : state.map ? 'VGGT · 相对尺度' : '尚未建图';
  $('map-status').textContent = state.map ? `${state.map.frameCount} 帧已对齐 · ${state.objects.filter(o => o.lastSeen?.mapId === state.map.id && o.lastSeen.position).length} 个空间物体` : '等待空间重建';
  $('map-note').textContent = demo ? '视频、深度、位姿为合成数据' : '关键帧批量重建；单目尺度未标定，不显示米数';
  $('stage-map').textContent = state.map ? demo ? '合成位姿 + 深度' : 'VGGT 相对坐标' : '未定位 / 图像记忆';
  $('build-map').disabled = demo || ['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state.reconstruction?.status);
  $('auto-map').disabled = demo || !config?.reconstruction.configured;
  $('build-map').textContent = demo ? '演示地图已连接' : state.reconstruction?.status === 'completed' ? '更新 3D 地图' : ['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state.reconstruction?.status) ? '3D 重建中…' : '重建 3D';
  map.setState(state); renderGuidance(state.guidance);
}
function renderGuidance(guidance) {
  feedback.update(guidance);
  const active = guidance?.status === 'direction';
  $('direction-orb').classList.toggle('aligned', Boolean(guidance?.aligned));
  $('direction-arrow').style.transform = `rotate(${active ? guidance.bearingDeg : 0}deg)`;
  $('direction-label').textContent = active ? guidance.aligned ? 'ALIGNED' : `${Math.round(Math.abs(guidance.bearingDeg))}° ${guidance.bearingDeg > 0 ? 'RIGHT' : 'LEFT'}` : 'READY';
  $('distance').textContent = active ? (guidance.distanceM ?? guidance.distanceRelative).toFixed(2) : '—';
  $('distance-unit').textContent = active ? guidance.coordinateUnits === 'meters' ? 'm · 模拟距离' : '相对单位 · 未标定' : '未定位';
  $('guide-target').textContent = guidance ? `寻找 ${guidance.label || ''} / LAST SEEN` : '让记忆带路';
  $('voice-feedback').textContent = active ? guidance.aligned ? '方向正确' : '调整视角' : '等待指令';
  $('haptic-feedback').textContent = guidance?.aligned ? '已对准 · 轻震' : typeof navigator.vibrate === 'function' ? '对准后轻震' : '桌面屏幕模拟';
  $('pulse-feedback').textContent = feedback.enabled && active ? `咚咚 · ${(1000 / guidance.pulse.intervalMs).toFixed(1)} Hz` : '声音已关闭';
  $('volume-bar').style.width = active ? `${guidance.pulse.gain / .45 * 100}%` : '0%';
  $('stage-recall').textContent = guidance ? active ? '方向 / 轻震 / 距离音' : '寻找已有图像证据' : '等待寻找目标';
  document.querySelectorAll('[data-move]').forEach(b => b.disabled = !active);
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
    ctx.strokeStyle = '#d3f58c'; ctx.lineWidth = 1; ctx.strokeRect(x - 5, y - 5, bw + 10, bh + 10);
    const label = state.objects.find(o => o.id === detection.entityId)?.label || detection.entityId;
    ctx.font = '9px -apple-system,sans-serif'; const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#d3f58c'; ctx.fillRect(x - 5, y - 23, tw + 13, 17); ctx.fillStyle = '#18301c'; ctx.fillText(label, x + 1, y - 11);
  }
}
async function ask(text) {
  if (queryBusy || !text.trim()) return;
  queryBusy = true; listening = false; recognition?.abort();
  try {
    setStage('recall'); $('query-input').value = text;
    const generation = epoch, result = await api('query', { sessionId: state.session.id, text });
    if (generation !== epoch) return;
    render(result.state); map.simPose = null; map.render(); $('answer').textContent = result.message;
    $('checklist').hidden = !result.checklist;
    $('checklist').innerHTML = result.checklist ? result.checklist.map(o => `<span>${o.lastSeen ? '◉' : '○'} ${escape(o.label)} · ${o.lastSeen ? '有记忆' : '未见到'}</span>`).join('') + '<p>记录不代表已携带，请逐件确认。</p>' : '';
    feedback.speak(result.message, true);
  } catch (error) { toast(error.message); } finally { queryBusy = false; }
}
async function move(action) {
  if (moveBusy || !state?.guidance || state.guidance.status !== 'direction') return;
  moveBusy = true;
  try {
    const generation = epoch, result = await api('move', { sessionId: state.session.id, action });
    if (generation !== epoch) return;
    state.guidance = result.guidance; map.setPose(result.pose); renderGuidance(result.guidance); $('answer').textContent = result.guidance.instruction; feedback.speak(result.guidance.instruction);
  } catch (error) { toast(error.message); } finally { moveBusy = false; }
}
function dialog(title, html) { $('detail-title').textContent = title; $('detail-body').innerHTML = html; if (!$('detail-dialog').open) $('detail-dialog').showModal(); }
function inspectObject(objectId) {
  const object = state.objects.find(o => o.id === objectId), last = object.lastSeen;
  dialog(`${object.label} · 物体记忆`, `${last ? `<img src="${escape(object.evidenceUrl)}" alt="${escape(object.label)}最后被观察到的完整证据帧">` : '<p>尚未看到这个物体。开始观察视频后，它的证据会出现在这里。</p>'}<div class="metadata"><div><small>身份</small><b>${escape(object.id)}</b></div><div><small>证据来源</small><b>${last ? last.evidence.synthetic ? '合成录像 / 已标注检测' : '真实视频 / Gemini' : '等待观察'}</b></div><div><small>空间坐标</small><b>${last?.position ? last.position.map(n => n.toFixed(3)).join(', ') + (last.coordinateUnits === 'relative' ? ' · 相对尺度' : ' m · 合成') : '未定位'}</b></div></div><button id="find-detail" class="button light">寻找${escape(object.label)} <svg><use href="#i-arrow"/></svg></button><h3>持久化记录 · 包含证据哈希与相机引用</h3><pre>${escape(JSON.stringify({ entity: object.id, lastSeen: last, latestCheck: object.latestCheck }, null, 2))}</pre>`);
  $('find-detail').addEventListener('click', () => { $('detail-dialog').close(); ask(`帮我找${object.label}`); });
}
async function storage() {
  try {
    const result = await api('export');
    dialog('每一段记忆，都有证据', `<p>物体观察、捕获时相机位姿与证据图片一起保存。图像用 SHA-256 命名；内存状态通过原子替换写入 JSON。刷新页面后仍可查询。</p><div class="metadata"><div><small>观察记录</small><b>${result.memory.observations.length}</b></div><div><small>相机位姿</small><b>${result.memory.poses.length}</b></div><div><small>地图点</small><b>${result.session.map?.points.length || 0}</b></div></div><button id="download-memory" class="button light">导出完整记忆 JSON ↓</button><h3>最近一条物体记录</h3><pre>${escape(JSON.stringify(result.memory.observations.at(-1) || { status: 'waiting_for_observation' }, null, 2))}</pre><h3>存储关系</h3><pre>session.json → map / keyframes / reconstruction job\nspatial-memory.json → entity → observation → poseRef\nevidence/&lt;sha256&gt;.jpg ← observation.evidence\nframes/&lt;frame_id&gt;.json → capture pose + timestamp</pre>`);
    $('download-memory').addEventListener('click', () => { const u = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = `pocketrecall-${state.session.id.slice(0, 8)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); });
  } catch (error) { toast(error.message); }
}
function settings() {
  dialog('服务连接与演示边界', `<div class="metadata"><div><small>物体识别</small><b>Gemini · ${config.vision.configured ? '密钥已配置' : '未配置'}</b></div><div><small>3D 重建</small><b>fal VGGT · ${config.reconstruction.configured ? '密钥已配置' : '未配置'}</b></div><div><small>实际硬件</small><b>浏览器模拟，无眼镜连接</b></div></div><p>Gemini 接收抽样帧，输出物体边界框与描述。VGGT 将不同视角的关键帧重建为点云、相机位姿和深度；结果按同一帧绑定到物体记忆。它是批量任务，尚不是持续 SLAM。</p><p>Gemini：${escape(config.vision.model)}。3D 服务在本机 <code>.env.local</code> 配置 <code>FAL_KEY</code> 后重启即可使用；密钥只在服务端读取。API 实际可用性以一次成功请求为准。</p><p>单目重建默认使用相对单位；没有真实尺度标定时不会显示米数。当前方向按钮操作的是虚拟佩戴者。桌面用动画模拟震动；支持 Vibration API 的设备可轻震。声音需先点击启用。</p><p>内置录像由程序合成，包含已知物体、深度和相机位姿。用于验证完整交互与存储，不代表真实视觉识别成功。</p><p><a href="https://fal.ai/models/fal-ai/vggt-1b/api" target="_blank" rel="noreferrer">VGGT API 文档 ↗</a> · <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Gemini API ↗</a></p>`);
}
async function buildMap() {
  if (!config.reconstruction.configured) { settings(); toast('真实 3D 重建还需要 FAL_KEY。Gemini 密钥用于物体识别，不能调用 VGGT。'); return; }
  try { setStage('map'); const generation = epoch, next = await api('reconstruct', { sessionId: state.session.id }); if (generation !== epoch) return; render(next); schedulePoll(); }
  catch (error) { toast(error.message); }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!['IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(state?.reconstruction?.status)) return;
  pollTimer = setTimeout(async () => {
    const generation = epoch;
    try { const next = await api('reconstruction'); if (epoch !== generation) return; render(next); if (next.reconstruction?.status === 'completed') toast('空间地图已保存。点击物体即可模拟寻找。'); else schedulePoll(); }
    catch (error) { toast(error.message); }
  }, 2500);
}
async function microphone() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { $('speech-note').textContent = '此浏览器未提供语音识别，请直接输入。'; $('query-input').focus(); return; }
  if (listening) { recognition?.stop(); return; }
  feedback.context?.suspend(); window.speechSynthesis?.cancel();
  recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = true; recognition.continuous = false;
  recognition.onstart = () => { listening = true; $('mic-button').classList.add('listening'); $('speech-note').textContent = '正在听… 说“帮我找钥匙”或“我要出发了”'; };
  recognition.onresult = event => { const result = event.results[event.resultIndex]; $('query-input').value = result[0].transcript; if (result.isFinal) ask(result[0].transcript); };
  recognition.onerror = event => { $('speech-note').textContent = event.error === 'not-allowed' ? '麦克风未授权，可以直接输入指令。' : `语音未完成（${event.error}），可以重试或输入。`; };
  recognition.onend = () => { listening = false; $('mic-button').classList.remove('listening'); if (feedback.enabled) feedback.context?.resume(); };
  try { recognition.start(); } catch { toast('语音识别未能启动，请直接输入。'); }
}

$('play-button').addEventListener('click', play);
$('restart').addEventListener('click', () => restart().catch(e => toast(e.message)));
$('sample-button').addEventListener('click', () => loadSource({ mode: 'demo', url: '/assets/demo-first-person.mp4', filename: 'PocketRecall · 合成第一视角录像' }).catch(e => toast(e.message)));
$('public-sample').addEventListener('click', () => loadSource({ mode: 'video', url: 'https://huggingface.co/spaces/facebook/vggt/resolve/main/examples/videos/room.mp4', filename: 'VGGT / room.mp4 · 公开室内相机录像' }).then(() => toast('来源：facebook/vggt 公开样片。可播放后点击观察；网络或跨站取帧受限时，请下载后上传。')).catch(e => toast(e.message)));
$('upload-button').addEventListener('click', () => $('video-file').click());
$('video-file').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024 * 1024) { toast('演示请选择 1 GB 以内的视频。'); return; } try { await loadSource({ mode: 'video', url: URL.createObjectURL(file), filename: file.name, file }); } catch (e) { toast(e.message); } event.target.value = ''; });
$('timeline').addEventListener('input', event => { if (Number.isFinite(video.duration)) video.currentTime = Number(event.target.value); });
video.addEventListener('loadedmetadata', () => { $('timeline').max = video.duration || 24; });
video.addEventListener('loadeddata', () => { $('video-error').hidden = true; if (state?.session.mode === 'demo' && !state.frameCount) processFrame().catch(e => toast(e.message)); });
video.addEventListener('ended', () => { pause(); toast('录像观察结束，记忆已保存。现在试着说：帮我找钥匙。'); });
video.addEventListener('error', () => { pause(); $('video-error').hidden = false; $('video-error').textContent = '视频未能加载。请上传本机 MP4 / WebM，或切换到内置演示。公开样片需要浏览器能够访问 Hugging Face。'; });
video.addEventListener('timeupdate', () => { $('timeline').value = video.currentTime; $('time-label').textContent = `${time(video.currentTime)} / ${time(video.duration)}`; $('feed-clock').textContent = `${time(video.currentTime)}.${Math.floor(video.currentTime % 1 * 10)}`; drawBoxes(); });
new ResizeObserver(drawBoxes).observe($('video-stage'));
$('query-form').addEventListener('submit', event => { event.preventDefault(); ask($('query-input').value); });
document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => ask(button.dataset.query)));
document.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => move(button.dataset.move)));
window.addEventListener('keydown', event => { if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || /INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName) || $('detail-dialog').open || $('add-dialog').open) return; const action = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'forward', w: 'forward', ArrowDown: 'back', s: 'back', q: 'up', e: 'down' }[event.key]; if (action && state?.guidance?.status === 'direction') { event.preventDefault(); move(action); } });
$('sound-toggle').addEventListener('click', async () => { try { if (feedback.enabled) feedback.disable(); else { await feedback.enable(); feedback.speak('声音指引已开启。', true); } $('sound-toggle').innerHTML = `<svg><use href="#i-sound"/></svg>${feedback.enabled ? '声音已开启' : '开启声音'}`; $('sound-toggle').setAttribute('aria-pressed', String(feedback.enabled)); renderGuidance(state.guidance); } catch (error) { toast(error.message); } });
$('mic-button').addEventListener('click', microphone);
$('reset-map').addEventListener('click', () => map.reset());
$('build-map').addEventListener('click', buildMap);
$('inspect-storage').addEventListener('click', storage); $('nav-memory').addEventListener('click', storage);
$('nav-run').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('nav-about').addEventListener('click', () => dialog('从第一视角，到空间记忆', '<p><b>01 看到。</b> 上传一段第一视角视频，像眼镜一样持续送入抽样帧；浏览器只保留一个识别请求，避免积压。</p><p><b>02 记住。</b> Gemini 给物体添加边界框与语义。VGGT 重建关键帧的相机位姿和深度，投影得到空间坐标。原始证据、捕获时间、位姿与物体记录一起落盘。</p><p><b>03 找回。</b> 说出目标，检索最后一次视觉证据。用方向键模拟转头和移动：语音给方向，对准轻震，越近心跳越响。</p><p><b>04 确认。</b> 最后出现的位置是寻找起点，不代表物体仍在那里。离开检查也不能代替确认已经带上物品。</p><p>完整体验无需实体眼镜。内置示例为合成数据；上传视频的检测使用真实 Gemini API，3D 重建需配置 fal 服务。</p>'));
$('open-settings').addEventListener('click', settings);
$('close-detail').addEventListener('click', () => $('detail-dialog').close());
$('add-object').addEventListener('click', () => $('add-dialog').showModal()); $('close-add').addEventListener('click', () => $('add-dialog').close());
$('add-form').addEventListener('submit', async event => { event.preventDefault(); try { render(await api('register', { sessionId: state.session.id, label: $('object-name').value })); $('object-name').value = ''; $('add-dialog').close(); toast('已添加，下一个真实视频帧会开始留意这个物体。'); } catch (e) { toast(e.message); } });
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { document.body.classList.toggle('presentation'); toast('已切换紧凑演示视图。'); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); feedback.context?.suspend(); recognition?.abort(); window.speechSynthesis?.cancel(); } else if (feedback.enabled) { feedback.context?.resume(); feedback.schedule(); } });
window.addEventListener('pagehide', () => { pause(); feedback.disable(); recognition?.abort(); clearTimeout(pollTimer); if (sourceFile) URL.revokeObjectURL(sourceUrl); });

async function initialize() {
  try {
    [config, state] = await Promise.all([api('config'), api('state')]);
    seq = state.session.lastSeq; lastProcessed = state.session.lastVideoTime; render(state); schedulePoll();
    $('api-status').textContent = `GEMINI ${config.vision.configured ? 'CONFIGURED' : 'OFFLINE'} · VGGT ${config.reconstruction.configured ? 'CONFIGURED' : 'NOT SET'}`;
    if (state.session.mode === 'demo') { video.src = sourceUrl; video.load(); }
    else { $('video-error').hidden = false; $('video-error').textContent = '上次的物体记忆已恢复。重新上传原视频以继续观察，或选择内置演示开始新会话。'; }
    updateControls();
  } catch (error) { $('connection').textContent = 'SERVER OFFLINE'; toast(error.message, true); }
}
initialize();
