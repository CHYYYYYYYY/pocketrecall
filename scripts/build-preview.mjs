import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const data = (file, type) => `data:${type};base64,${fs.readFileSync(path.join(root, file)).toString('base64')}`;
const fixture = read('public/assets/demo-manifest.json');
const moduleSource = (file, exports) => `const {${exports.join(',')}} = (() => {\n${read(file).replace(/^import .*?;\s*$/gm, '').replace(/\bexport /g, '')}\nreturn {${exports.join(',')}};})();\n`;
let js = moduleSource('lib/spatial/geometry.mjs', ['guideToTarget', 'unprojectToWorld']);
js += moduleSource('public/run-offline.js', ['OfflineRun']);
js += moduleSource('public/run-map.js', ['SpatialMap']);
js += moduleSource('public/run-feedback.js', ['Feedback']);
js += `let previewStorage; try { previewStorage = localStorage; } catch {}\nconst previewEngine = new OfflineRun(${fixture}, previewStorage);\nconst originalFetch = window.fetch.bind(window);\nwindow.fetch = async (url, options = {}) => { if (!String(url).startsWith('/api/run/')) return originalFetch(url, options); try { return Response.json(await previewEngine.request(String(url).slice(9), options.body ? JSON.parse(options.body) : undefined)); } catch (error) { return Response.json({error:error.message},{status:error.status||400}); } };\n`;
js += read('public/run.js').replace(/^import .*?;\s*$/gm, '')
  .replaceAll("'/assets/demo-first-person.mp4'", JSON.stringify(data('public/assets/demo-first-person.mp4', 'video/mp4')))
  .replace("$('api-status').textContent = `GEMINI ${config.vision.configured ? 'CONFIGURED' : 'OFFLINE'} · VGGT ${config.reconstruction.configured ? 'CONFIGURED' : 'NOT SET'}`;", "$('api-status').textContent = 'OFFLINE PREVIEW · SYNTHETIC DATA';")
  .replace('旧会话的证据仍保存在本机。', '离线预览已开始新的浏览器会话。')
  .replace('本机持久保存', '浏览器保存');
const css = read('public/run.css');
let html = read('public/run.html').replace('<link rel="stylesheet" href="/run.css">', `<style>${css}</style>`)
  .replace('/assets/demo-poster.jpg', data('public/assets/demo-poster.jpg', 'image/jpeg'))
  .replace('<script type="module" src="/run.js"></script>', `<script type="module">\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`)
  .replace('<title>PocketRecall — Spatial memory lab</title>', '<title>PocketRecall — 离线交互预览</title>')
  .replace('LOCAL SESSION', 'OFFLINE PREVIEW').replace('本机持久保存', '浏览器保存')
  .replace('href="/run"', 'href="#"').replace('<a href="/desk">经典桌面演示 ↗</a>', '<span>真实 API：运行项目后打开 /run</span>');
const out = path.join(root, 'public/pocketrecall-preview.html'); fs.writeFileSync(out, html);
console.log(`Standalone preview built (${(Buffer.byteLength(html)/1024/1024).toFixed(2)} MB). No keys or external dependencies embedded.`);
