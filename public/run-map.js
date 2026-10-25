const COLORS = { keys: '#efa57e', wallet: '#d7c8a5', earbuds: '#d9e1d1', phone: '#b8cebb' };
export class SpatialMap {
  constructor(canvas, onSelect) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect;
    this.yaw = -.42; this.pitch = .58; this.zoom = 1; this.center = [0, .7, -.8]; this.scale = 100;
    this.state = null; this.hits = []; this.pointer = null; this.moved = false;
    canvas.addEventListener('pointerdown', e => { this.pointer = [e.clientX, e.clientY]; this.moved = false; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (!this.pointer) return;
      const dx = e.clientX - this.pointer[0], dy = e.clientY - this.pointer[1];
      this.yaw += dx * .008; this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + dy * .006));
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      this.pointer = [e.clientX, e.clientY]; this.render();
    });
    const up = e => { this.pointer = null; if (!this.moved) { const r = canvas.getBoundingClientRect(); const hit = this.hits.find(h => Math.hypot(e.clientX - r.left - h.x, e.clientY - r.top - h.y) < 25); if (hit) this.onSelect?.(hit.id); } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', () => this.pointer = null);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom = Math.max(.4, Math.min(3, this.zoom * Math.exp(-e.deltaY * .001))); this.render(); }, { passive: false });
    this.resize = new ResizeObserver(() => this.render()); this.resize.observe(canvas);
    this.render();
  }
  reset() { this.yaw = -.42; this.pitch = .58; this.zoom = 1; this.render(); }
  setState(state) {
    this.state = state;
    if (state.map && (this.mapId !== state.map.id || this.fittedSession !== state.session?.id || this.pointCount !== state.map.points.length)) {
      this.mapId = state.map.id; this.fittedSession = state.session?.id; this.pointCount = state.map.points.length;
      const pts = state.map.points.filter((_, i) => i % 20 === 0);
      if (pts.length) {
        const mins = [0, 1, 2].map(k => Math.min(...pts.map(p => p[k])));
        const maxs = [0, 1, 2].map(k => Math.max(...pts.map(p => p[k])));
        this.center = mins.map((v, i) => (v + maxs[i]) / 2);
        this.extent = Math.max(...maxs.map((v, i) => v - mins[i]), .1);
        this.flip = state.map.source === 'fal-ai/vggt-1b' ? -1 : 1;
      }
    }
    this.render();
  }
  setPose(pose) { this.simPose = pose; this.render(); }
  project(p) {
    const x = p[0] - this.center[0], y = (p[1] - this.center[1]) * (this.flip || 1), z = p[2] - this.center[2];
    const a = x * Math.cos(this.yaw) + z * Math.sin(this.yaw), b = z * Math.cos(this.yaw) - x * Math.sin(this.yaw);
    const v = y * Math.cos(this.pitch) - b * Math.sin(this.pitch), depth = b * Math.cos(this.pitch) + y * Math.sin(this.pitch);
    const perspective = 1 / Math.max(.6, 1 + depth / ((this.extent || 5) * 3));
    return { x: this.width / 2 + a * this.scale * perspective, y: this.height * .53 - v * this.scale * perspective, z: depth };
  }
  line(points, color, width = 1, dash = []) {
    const ctx = this.ctx; ctx.beginPath(); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.setLineDash(dash);
    points.map(p => this.project(p)).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); ctx.setLineDash([]);
  }
  render() {
    const canvas = this.canvas, ctx = this.ctx, rect = canvas.getBoundingClientRect();
    this.width = rect.width || 600; this.height = rect.height || 340;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(this.width * dpr) || canvas.height !== Math.round(this.height * dpr)) { canvas.width = Math.round(this.width * dpr); canvas.height = Math.round(this.height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, this.width, this.height);
    this.scale = Math.min(this.width * .8, this.height * 1.1) / (this.extent || 5) * this.zoom;
    const size = (this.extent || 5) * .65, y = this.center[1] - (this.extent || 5) * .24;
    for (let i = -7; i <= 7; i++) {
      const v = i / 7 * size;
      this.line([[this.center[0] - size, y, this.center[2] + v], [this.center[0] + size, y, this.center[2] + v]], '#a2b09514');
      this.line([[this.center[0] + v, y, this.center[2] - size], [this.center[0] + v, y, this.center[2] + size]], '#a2b09514');
    }
    this.hits = [];
    const map = this.state?.map;
    if (!map) return;
    const stride = Math.max(1, Math.ceil(map.points.length / 25000));
    const dots = map.points.filter((_, i) => i % stride === 0).map(p => ({ ...this.project(p), color: p[3] || '#69bda3' })).sort((a, b) => b.z - a.z);
    ctx.globalAlpha = .9;
    for (const p of dots) {
      if (p.x < 0 || p.y < 0 || p.x > this.width || p.y > this.height) continue;
      ctx.fillStyle = p.color; const s = 1.7 * Math.min(this.zoom, 1.5); ctx.fillRect(p.x, p.y, s, s);
    }
    ctx.globalAlpha = 1;
    const positions = map.poses.map(p => [p.worldFromCamera[3], p.worldFromCamera[7], p.worldFromCamera[11]]);
    if (positions.length > 1) this.line(positions, '#83b3eea0', 1.5, [4, 3]);
    const pose = this.simPose?.mapId === map.id ? this.simPose : map.poses.at(-1);
    if (pose) {
      const m = pose.worldFromCamera, p = [m[3], m[7], m[11]], step = (this.extent || 5) * .08;
      const end = p.map((v, i) => v + m[i * 4 + 2] * step);
      this.line([p, end], '#9fc5ff', 2);
      const pp = this.project(p); ctx.fillStyle = '#9fc5ff'; ctx.beginPath(); ctx.arc(pp.x, pp.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = '8px ui-monospace, monospace'; ctx.fillStyle = '#9dbce4'; ctx.fillText('YOU', pp.x + 8, pp.y - 7);
      const target = this.state.objects.find(o => o.id === this.state.targetId)?.lastSeen;
      if (target?.position && target.mapId === map.id) this.line([p, target.position], '#efa57eaa', 1, [3, 4]);
    }
    for (const object of this.state.objects) {
      const last = object.lastSeen;
      if (!last?.position || last.mapId !== map.id) continue;
      const p = this.project(last.position), color = COLORS[object.id] || '#d9e1d1';
      const selected = object.id === this.state.targetId;
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 9 : 5, 0, Math.PI * 2); ctx.stroke();
      if (selected) { ctx.globalAlpha = .12; ctx.beginPath(); ctx.arc(p.x, p.y, 21, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
      ctx.font = '11px "Helvetica Neue", sans-serif';
      const label = object.label, w = ctx.measureText(label).width;
      const offset = object.id === 'earbuds' ? -33 : -21;
      ctx.fillStyle = '#252c27ee'; ctx.fillRect(p.x - w / 2 - 6, p.y + offset - 9, w + 12, 18);
      ctx.strokeStyle = `${color}70`; ctx.strokeRect(p.x - w / 2 - 6, p.y + offset - 9, w + 12, 18);
      ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.fillText(label, p.x, p.y + offset + 4); ctx.textAlign = 'left';
      this.hits.push({ x: p.x, y: p.y, id: object.id });
    }
    // Orientation axes rotate with the point cloud.
    const origin = [this.center[0] - size, y, this.center[2] + size];
    for (const [index, color, label] of [[0, '#be8f7c', 'X'], [1, '#a4c68d', 'Y'], [2, '#829fcb', 'Z']]) {
      const end = [...origin]; end[index] += size * .18; this.line([origin, end], color);
      const q = this.project(end); ctx.fillStyle = color; ctx.font = '8px ui-monospace, monospace'; ctx.fillText(label, q.x + 3, q.y);
    }
  }
}
