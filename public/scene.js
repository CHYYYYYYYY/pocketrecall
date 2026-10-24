/** A schematic table-plane view. Heights are illustration, never measured 3D. */
const INK = '#0d1d20';
const COLORS = { keys: '#ddeb85', wallet: '#91c5b6', earbuds: '#b8b4e3' };
const NAMES = { keys: 'Keys', wallet: 'Wallet', earbuds: 'Earbuds' };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function rounded(ctx, x, y, w, h, r = 8) {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

function polygon(ctx, points, fill, stroke) {
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

function ageLabel(time) {
  const milliseconds = Date.now() - new Date(time).getTime();
  if (!Number.isFinite(milliseconds)) return 'time unavailable';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function positionOf(observation) {
  const p = observation?.position;
  if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return p;
  const b = observation?.bbox;
  if (Array.isArray(b) && b.length === 4) return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
  return null;
}

function objectIcon(ctx, id, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 40, size / 40);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (id === 'keys') {
    ctx.beginPath(); ctx.arc(-7, -6, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-2, -1); ctx.lineTo(13, 14); ctx.lineTo(17, 10);
    ctx.moveTo(8, 9); ctx.lineTo(12, 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-10, 1); ctx.lineTo(-10, 13); ctx.lineTo(-4, 13); ctx.stroke();
  } else if (id === 'wallet') {
    rounded(ctx, -17, -11, 34, 23, 4); ctx.stroke();
    rounded(ctx, 3, -4, 16, 11, 3); ctx.fill();
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(9, 1.5, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-11, -6); ctx.lineTo(9, -6); ctx.stroke();
  } else {
    rounded(ctx, -16, -8, 32, 24, 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-14, 1); ctx.lineTo(14, 1); ctx.stroke();
    ctx.beginPath(); ctx.arc(-7, -12, 4, 0, Math.PI * 2); ctx.arc(7, -12, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export class DeskScene {
  constructor(canvas, { onSelect } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.state = null;
    this.selectedObjectId = null;
    this.selectedObservationId = null;
    this.hitAreas = [];
    this.hoveredId = null;
    this.destroyed = false;
    this.click = event => {
      const hit = this.hitTest(event);
      if (hit) this.onSelect?.(hit.id, hit.observationId);
    };
    this.move = event => {
      const hit = this.hitTest(event);
      this.canvas.style.cursor = hit ? 'pointer' : 'default';
      if ((hit?.id || null) !== this.hoveredId) { this.hoveredId = hit?.id || null; this.render(); }
    };
    canvas.addEventListener('click', this.click);
    canvas.addEventListener('mousemove', this.move);
    canvas.setAttribute('aria-label', 'Schematic spatial memory of the desk. Dashed objects indicate historical positions.');
    this.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.render()) : null;
    this.resizeObserver?.observe(canvas);
    this.timer = setInterval(() => this.render(), 1000);
    this.render();
  }

  setState(state, { selectedObjectId, selectedObservationId } = {}) {
    this.state = state;
    if (selectedObjectId !== undefined) this.selectedObjectId = selectedObjectId;
    this.selectedObservationId = selectedObservationId === undefined ? this.selectedObservationId : selectedObservationId;
    this.render();
  }

  hitTest(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - this.offsetX) / this.scale;
    const y = (event.clientY - rect.top - this.offsetY) / this.scale;
    return [...this.hitAreas].reverse().find(area => x > area.x && x < area.x + area.w && y > area.y && y < area.y + area.h);
  }

  project(x, y, z = 0) { return { x: 465 + 450 * x - 390 * y, y: 122 + 188 * x + 232 * y - z }; }

  planeRect(x, y, w, h, elevation = 0, fill = '#35504f', edge = '#54716b') {
    const points = [this.project(x, y, elevation), this.project(x + w, y, elevation), this.project(x + w, y + h, elevation), this.project(x, y + h, elevation)];
    polygon(this.ctx, points, fill, edge);
    return points;
  }

  render() {
    if (this.destroyed || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.canvas.width || 900;
    const h = rect.height || 520;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#142a2c'); bg.addColorStop(1, '#0b1c20');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    this.scale = Math.min(w / 1000, h / 620);
    this.offsetX = (w - 1000 * this.scale) / 2;
    this.offsetY = (h - 620 * this.scale) / 2;
    ctx.translate(this.offsetX, this.offsetY); ctx.scale(this.scale, this.scale);
    // Surrounding HTML provides the title and legend. Keep the canvas focused on memory.
    ctx.fillStyle = '#234143';
    for (let x = 35; x < 980; x += 26) for (let y = 65; y < 565; y += 26) {
      ctx.beginPath(); ctx.arc(x, y, .7, 0, Math.PI * 2); ctx.fill();
    }

    // Raised desk slab; all object coordinates lie on the calibrated plane.
    const corners = [this.project(0, 0), this.project(1, 0), this.project(1, 1), this.project(0, 1)];
    const shadow = corners.map(p => ({ x: p.x, y: p.y + 28 }));
    ctx.save(); ctx.shadowColor = '#0009'; ctx.shadowBlur = 38; polygon(ctx, shadow, '#061416'); ctx.restore();
    polygon(ctx, [corners[1], corners[2], { x: corners[2].x, y: corners[2].y + 16 }, { x: corners[1].x, y: corners[1].y + 16 }], '#1b3435', '#3a5551');
    polygon(ctx, [corners[2], corners[3], { x: corners[3].x, y: corners[3].y + 16 }, { x: corners[2].x, y: corners[2].y + 16 }], '#203c3b', '#47605a');
    polygon(ctx, corners, '#294544', '#6b8775');
    ctx.lineWidth = .75; ctx.strokeStyle = '#45635b';
    for (let i = 1; i < 8; i++) {
      const a = this.project(i / 8, 0), b = this.project(i / 8, 1);
      const c = this.project(0, i / 8), d = this.project(1, i / 8);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }

    // Demo landmarks are illustrations; do not invent landmarks for live camera data.
    if (this.state?.session?.mode !== 'live') {
    this.planeRect(.37, .11, .26, .13, 2, '#1e3736', '#547369');
    const stand = this.project(.51, .14);
    ctx.strokeStyle = '#66877a'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(stand.x, stand.y); ctx.lineTo(stand.x, stand.y - 42); ctx.stroke();
    const screenLeft = this.project(.30, .10, 35), screenRight = this.project(.73, .10, 35);
    polygon(ctx, [screenLeft, screenRight, { x: screenRight.x, y: screenRight.y - 98 }, { x: screenLeft.x, y: screenLeft.y - 98 }], '#10282c', '#789483');
    ctx.strokeStyle = '#476e64'; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(screenLeft.x + 18, screenLeft.y - 69 + i * 13);
      ctx.lineTo(screenRight.x - 20 - i * 28, screenRight.y - 69 + i * 13); ctx.stroke();
    }
    const cup = this.project(.12, .26, 0);
    ctx.fillStyle = '#476d63'; ctx.beginPath(); ctx.ellipse(cup.x, cup.y - 12, 17, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(cup.x - 17, cup.y - 32, 34, 20);
    ctx.fillStyle = '#7da291'; ctx.beginPath(); ctx.ellipse(cup.x, cup.y - 32, 17, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#203d39'; ctx.beginPath(); ctx.ellipse(cup.x, cup.y - 33, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#7da291'; ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(cup.x + 20, cup.y - 22, 8, 10, 0, -.5 * Math.PI, .5 * Math.PI); ctx.stroke();
    }

    const observations = Array.isArray(this.state?.observations) ? this.state.observations : [];
    const selected = observations.find(o => o.id === this.selectedObservationId || o.observationId === this.selectedObservationId);
    const objects = Array.isArray(this.state?.objects) ? this.state.objects : [];
    const historicalTime = selected ? new Date(selected.capturedAt).getTime() : null;
    const keys = objects.find(o => o.id === 'keys');
    if (this.state?.session?.mode === 'demo' && !selected && keys?.latestCheck?.status === 'not_seen' && keys?.lastSeen) {
      const pos = positionOf(keys.lastSeen);
      if (pos) {
        this.planeRect(pos.x - .08, pos.y - .09, .19, .18, 3, '#65776a', '#94a68a');
        this.planeRect(pos.x - .07, pos.y - .08, .02, .16, 4, '#344e48', null);
      }
    }

    const inDesk = p => !this.state?.calibration || (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    const events = (this.state?.events || []).filter(e => e.objectId === (this.selectedObjectId || 'keys') && positionOf({ position: e.from }) && positionOf({ position: e.to }) && inDesk(e.from) && inDesk(e.to) && (!historicalTime || new Date(e.capturedAt).getTime() <= historicalTime));
    ctx.save(); ctx.setLineDash([5, 7]); ctx.strokeStyle = '#ddeb8566'; ctx.lineWidth = 1.8;
    events.slice(-3).forEach(event => {
      const a = this.project(event.from.x, event.from.y, 2), b = this.project(event.to.x, event.to.y, 2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(a.x, a.y, 4, 0, Math.PI * 2); ctx.stroke();
    }); ctx.restore();

    this.hitAreas = [];
    const outsideDesk = [];
    const drawable = objects.map(object => {
      let observation = object.lastSeen;
      if (selected) {
        observation = observations.filter(o => o.objectId === object.id && o.status !== 'not_seen' && o.visibility !== 'not_seen' && new Date(o.capturedAt).getTime() <= historicalTime && positionOf(o))
          .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0];
        if ((selected.objectId === object.id || selected.itemId === object.id) && positionOf(selected)) observation = selected;
      }
      const position = positionOf(observation);
      if (position && this.state?.calibration && (position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1)) {
        outsideDesk.push(object.id);
        return null;
      }
      return position ? { object, observation, position } : null;
    }).filter(Boolean).sort((a, b) => a.position.x + a.position.y - b.position.x - b.position.y);

    const cardScale = Math.max(1, .76 / this.scale);
    const placedCards = [];
    for (const { object, observation, position } of drawable) {
      const p = this.project(clamp(position.x, 0, 1), clamp(position.y, 0, 1));
      const isSelected = object.id === this.selectedObjectId || object.id === this.hoveredId;
      const historical = Boolean(selected) || object.latestCheck?.status !== 'seen' || this.state?.session?.observerState !== 'observing';
      const color = object.color || COLORS[object.id] || '#ddeb85';
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.globalAlpha = historical ? .45 : .92;
      ctx.lineWidth = isSelected ? 2.3 : 1.4;
      ctx.setLineDash(historical ? [4, 4] : []);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, isSelected ? 31 : 24, isSelected ? 15 : 12, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = .12; ctx.beginPath(); ctx.ellipse(p.x, p.y, 24, 12, 0, 0, Math.PI * 2); ctx.fill();
      const cardWidth = 138 * cardScale, cardHeight = 72 * cardScale;
      const baseY = Math.max(52, p.y - 29 - cardHeight);
      const candidates = [
        { x: p.x - cardWidth / 2, y: baseY },
        { x: p.x - cardWidth - 28, y: baseY },
        { x: p.x + 28, y: baseY },
        { x: p.x - cardWidth - 28, y: p.y + 25 },
        { x: p.x + 28, y: p.y + 25 },
        { x: p.x - cardWidth / 2, y: Math.max(52, baseY - cardHeight - 15) },
        { x: 25, y: 52 },
        { x: 975 - cardWidth, y: 52 },
        { x: 25, y: 552 - cardHeight },
        { x: 975 - cardWidth, y: 552 - cardHeight },
      ].map(c => ({ x: clamp(c.x, 25, 975 - cardWidth), y: clamp(c.y, 52, 552 - cardHeight), w: cardWidth, h: cardHeight }));
      const overlaps = candidate => placedCards.some(previous => candidate.x < previous.x + previous.w + 12 && candidate.x + candidate.w + 12 > previous.x && candidate.y < previous.y + previous.h + 12 && candidate.y + candidate.h + 12 > previous.y);
      const chosen = candidates.find(candidate => !overlaps(candidate)) || candidates[0];
      const { x, y } = chosen;
      placedCards.push(chosen);
      ctx.globalAlpha = .65; ctx.beginPath(); ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(clamp(p.x, x + 10, x + cardWidth - 10), p.y > y + cardHeight ? y + cardHeight : y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.save(); ctx.translate(x, y); ctx.scale(cardScale, cardScale);
      ctx.shadowColor = '#0005'; ctx.shadowBlur = 16;
      rounded(ctx, 0, 0, 138, 72, 12); ctx.fillStyle = isSelected ? '#223b39' : '#142b2c'; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = isSelected ? color : '#49645b'; ctx.setLineDash(historical ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
      objectIcon(ctx, object.id, 25, 26, 27, color);
      ctx.fillStyle = '#eef2df'; ctx.font = '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(object.name || NAMES[object.id] || object.id, 47, 26);
      ctx.font = '12px ui-monospace, monospace'; ctx.fillStyle = historical ? '#b8c5b1' : '#c7d78a';
      ctx.fillText(selected ? 'PAST OBSERVATION' : historical ? 'LAST SEEN' : 'OBSERVED', 12, 47);
      ctx.fillStyle = '#9eb4ab'; ctx.fillText(ageLabel(observation.capturedAt), 12, 62);
      ctx.restore();
      ctx.restore();
      this.hitAreas.push({ id: object.id, observationId: observation.id, x, y, w: cardWidth, h: cardHeight });
    }
    if (!drawable.length && !outsideDesk.length) {
      ctx.fillStyle = '#bdd0bf'; ctx.textAlign = 'center';
      ctx.font = `${16 * cardScale}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('A place for things you might forget.', 490, 384);
      ctx.font = `${12 * cardScale}px -apple-system, BlinkMacSystemFont, sans-serif`; ctx.fillStyle = '#88a49a';
      ctx.fillText('Start a demo or connect a camera.', 490, 384 + 23 * cardScale); ctx.textAlign = 'left';
    }
    ctx.font = `${10 * cardScale}px ui-monospace, monospace`; ctx.fillStyle = '#8eaaa0';
    ctx.textAlign = 'center';
    ctx.fillText(outsideDesk.length ? `${outsideDesk.length} observation${outsideDesk.length === 1 ? '' : 's'} outside calibrated desk` : events.length ? 'Dashed links: observed positions' : this.state?.session?.mode === 'live' && !this.state?.calibration ? 'Camera-relative positions' : 'YOUR SIDE', 500, 580);
    ctx.textAlign = 'left';
  }

  destroy() {
    this.destroyed = true; clearInterval(this.timer); this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('click', this.click); this.canvas.removeEventListener('mousemove', this.move);
  }
}

/** Deterministic synthetic camera substitute. Never used as a live inference fallback. */
export function drawDemoFrame(canvas, step = 0) {
  const n = clamp(Number(step) || 0, 0, 4);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is unavailable.');
  if (!canvas.width) canvas.width = 960;
  if (!canvas.height) canvas.height = 600;
  const w = canvas.width, h = canvas.height;
  ctx.save(); ctx.setTransform(w / 960, 0, 0, h / 600, 0, 0);
  const grain = ctx.createLinearGradient(0, 0, 960, 600);
  grain.addColorStop(0, '#d9cfb8'); grain.addColorStop(1, '#beb79f'); ctx.fillStyle = grain; ctx.fillRect(0, 0, 960, 600);
  ctx.strokeStyle = '#95896b14'; ctx.lineWidth = 1;
  for (let i = 0; i < 80; i++) {
    const y = i * 8;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(240, y - 9, 600, y + 12, 960, y + 3); ctx.stroke();
  }
  ctx.fillStyle = '#344540'; rounded(ctx, 69, 220, 822, 320, 25); ctx.fill();
  ctx.strokeStyle = '#52675a'; ctx.lineWidth = 1.5; rounded(ctx, 78, 229, 804, 302, 20); ctx.stroke();
  // Monitor and base, deliberately drawn rather than a photograph.
  ctx.save(); ctx.shadowColor = '#16222230'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#89928a'; rounded(ctx, 410, 155, 165, 30, 10); ctx.fill();
  ctx.fillStyle = '#374b48'; rounded(ctx, 327, 50, 314, 116, 12); ctx.fill(); ctx.restore();
  ctx.fillStyle = '#172d31'; rounded(ctx, 338, 60, 292, 91, 5); ctx.fill();
  ctx.fillStyle = '#51756b'; rounded(ctx, 358, 78, 116, 5, 2); ctx.fill();
  ctx.fillStyle = '#38574f'; rounded(ctx, 358, 92, 191, 4, 2); ctx.fill(); rounded(ctx, 358, 106, 166, 4, 2); ctx.fill();
  ctx.fillStyle = '#bbd28b'; ctx.beginPath(); ctx.arc(484, 158, 2, 0, Math.PI * 2); ctx.fill();
  // Ceramic mug as a stable visual landmark.
  ctx.save(); ctx.shadowColor = '#13221e30'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5;
  ctx.fillStyle = '#618b91'; ctx.beginPath(); ctx.arc(129, 153, 31, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 10; ctx.strokeStyle = '#618b91'; ctx.beginPath(); ctx.arc(164, 155, 12, -.5 * Math.PI, .5 * Math.PI); ctx.stroke(); ctx.restore();
  ctx.fillStyle = '#d1d8cb'; ctx.beginPath(); ctx.arc(129, 153, 25, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#584237'; ctx.beginPath(); ctx.arc(129, 153, 20, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#8b7360'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(126, 150, 14, 3.4, 5.3); ctx.stroke();
  const keysHidden = n === 2 || n === 3;
  const keysPos = n === 0 ? { x: .25, y: .68 } : n === 4 ? { x: .23, y: .38 } : { x: .70, y: .30 };
  const walletPos = n >= 3 ? { x: .50, y: .58 } : { x: .82, y: .72 };
  if (!keysHidden) {
    const x = keysPos.x * 960, y = keysPos.y * 600;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-.3); ctx.shadowColor = '#0005'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
    ctx.strokeStyle = '#e4c974'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(-10, -8, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#d3b25e'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(-1, 1); ctx.lineTo(29, 30); ctx.lineTo(35, 24); ctx.stroke();
    ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(18, 20); ctx.lineTo(25, 13); ctx.stroke();
    ctx.fillStyle = '#79aebb'; rounded(ctx, -33, 2, 25, 43, 7); ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = '#b4d5d5'; ctx.lineWidth = 1; rounded(ctx, -28, 9, 15, 29, 3); ctx.stroke(); ctx.restore();
  }
  const wx = walletPos.x * 960, wy = walletPos.y * 600;
  ctx.save(); ctx.translate(wx, wy); ctx.rotate(.12); ctx.shadowColor = '#0005'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 5;
  ctx.fillStyle = '#343735'; rounded(ctx, -51, -33, 102, 66, 9); ctx.fill(); ctx.shadowBlur = 0;
  ctx.strokeStyle = '#737366'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); rounded(ctx, -45, -27, 90, 54, 6); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#454a40'; rounded(ctx, 13, -10, 44, 26, 4); ctx.fill(); ctx.fillStyle = '#bab28a'; ctx.beginPath(); ctx.arc(28, 3, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  if (keysHidden) {
    ctx.save(); ctx.translate(675, 180); ctx.rotate(-.09); ctx.shadowColor = '#0004'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#e6dfc6'; rounded(ctx, -73, -51, 146, 109, 5); ctx.fill();
    ctx.fillStyle = '#84917b'; rounded(ctx, -76, -54, 146, 107, 5); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#4f6657'; ctx.fillRect(-65, -54, 7, 107);
    ctx.fillStyle = '#dbe0bb'; ctx.font = '10px ui-monospace, monospace'; ctx.fillText('FIELD NOTES', -35, -20);
    ctx.strokeStyle = '#acb69a'; ctx.lineWidth = 1; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-35, -5 + i * 9); ctx.lineTo(36, -5 + i * 9); ctx.stroke(); } ctx.restore();
  }
  // Permanent provenance marks remain embedded in every saved synthetic frame.
  ctx.fillStyle = '#132a29ef'; ctx.fillRect(0, 0, 960, 35);
  ctx.font = '600 12px ui-monospace, monospace'; ctx.fillStyle = '#e6edb7';
  ctx.fillText('SIMULATED DEMO  /  NOT A CAMERA FEED', 19, 23);
  ctx.textAlign = 'right'; ctx.fillStyle = '#9cbbb0'; ctx.fillText(`SCENE ${n + 1} / 5`, 940, 23); ctx.textAlign = 'left';
  ctx.fillStyle = '#132a29e8'; rounded(ctx, 19, 553, 625, 30, 6); ctx.fill();
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.fillStyle = '#e1e8d2';
  const captions = ['Keys on the left. Wallet on the right. Earbuds have not been observed.', 'Keys moved beside the monitor. A new observation is recorded.', 'Notebook covers the keys. Their last visible position remains in memory.', 'Wallet moved to the center. Keys remain unseen.', 'Keys are visible again. Their new position updates the memory.'];
  ctx.fillText(captions[n], 32, 573);
  ctx.restore();
  const box = (p, halfW, halfH) => [p.x - halfW, p.y - halfH, p.x + halfW, p.y + halfH];
  return {
    items: {
      keys: { status: keysHidden ? 'not_seen' : 'seen', bbox: keysHidden ? null : box(keysPos, .055, .075) },
      wallet: { status: 'seen', bbox: box(walletPos, .06, .065) },
      earbuds: { status: 'not_seen', bbox: null },
    },
    imageDataUrl: canvas.toDataURL('image/png'),
  };
}
