import fs from 'node:fs';
import path from 'node:path';

export const intrinsics = { fx: 600, fy: 600, cx: 320, cy: 240, width: 640, height: 480 };
const stamp = second => new Date(Date.UTC(2026, 9, 24, 20, 0, second)).toISOString();
export function cameraPose(id, second, x = 0, mapId = 'desk-map', trackingState = 'tracking') {
  return { id, mapId, capturedAt: stamp(second), trackingState, worldFromCamera: [1,0,0,x, 0,-1,0,1.4, 0,0,-1,2, 0,0,0,1] };
}
const positions = { first: [-.45,.75,0], moved: [.5,.75,0], wallet: [.7,.75,-.3] };
function detection(entityId, world, pose, method = 'depth') {
  const z = 2 - world[2], u = (world[0] - pose.worldFromCamera[3]) / z * 600 + 320, v = (1.4 - world[1]) / z * 600 + 240;
  return { entityId, status: 'seen', bbox: [(u-25)/640,(v-18)/480,(u+25)/640,(v+18)/480], ...(method === 'plane' ? { supportPlane: { normal: [0,1,0], offset: -.75 } } : { depthM: z }), uncertaintyM: .04, semantics: { support: 'desk', identityBasis: 'fixture ground truth; simulated' } };
}
function svg(detections, caption) {
  const items = detections.filter(d => d.status === 'seen').map(d => { const [x0,y0,x1,y1] = d.bbox; return `<rect x="${x0*640}" y="${y0*480}" width="${(x1-x0)*640}" height="${(y1-y0)*480}" rx="7" fill="${d.entityId === 'keys' ? '#d8ea8d' : '#47574b'}"/><text x="${x0*640}" y="${y0*480-9}" font-family="sans-serif" font-size="15" fill="#19352b">${d.entityId}</text>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#e5decb"/><path d="M0 340H640V480H0Z" fill="#c7ba97"/><path d="M0 340H640" stroke="#9c8e70"/><rect x="155" y="100" width="300" height="150" rx="15" fill="#29463a"/><text x="24" y="34" font-family="sans-serif" font-size="16" fill="#203d30">SIMULATED INPUT · NOT A CAMERA CAPTURE</text><text x="24" y="62" font-family="sans-serif" font-size="14" fill="#496049">${caption}</text>${items}</svg>`;
}
export function createScenario(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const entities = [
    { id: 'keys', label: 'Blue keyring', aliases: ['my keys','钥匙'], appearance: 'Blue strap with brass keys', priority: 'explicit' },
    { id: 'wallet', label: 'Dark wallet', aliases: ['wallet','钱包'], appearance: 'Dark folded wallet', priority: 'background' },
    { id: 'earbuds', label: 'White earbud case', aliases: ['earbuds','耳机'], appearance: 'White oval case', priority: 'background' },
  ];
  const frame = (id, second, source, keyWorld, x = 0, method = 'depth') => {
    const pose = cameraPose(`${id}-pose`, second, x);
    const detections = [keyWorld ? detection('keys',keyWorld,pose,method) : { entityId:'keys',status:'not_seen',bbox:null }, detection('wallet',positions.wallet,pose)];
    const imagePath = path.join(directory, `${id}.svg`);
    fs.writeFileSync(imagePath, svg(detections, `${id}: ${keyWorld ? 'keys visible' : 'keys not visible'}; camera x=${x}m`));
    return { type:'frame', label:id, frame:{id,capturedAt:stamp(second),source,synthetic:true,imagePath,pose,intrinsics,detections} };
  };
  const events = [
    frame('active-registration',0,'active',positions.first),
    frame('passive-move',10,'passive',positions.moved,0,'plane'),
    frame('occluded',20,'passive',null),
    { type:'query',label:'before-viewpoint-change',entityId:'keys' },
    { type:'pose',pose:cameraPose('user-moved',25,.9) },
    { type:'query',label:'after-viewpoint-change',entityId:'keys' },
    { type:'pose',pose:cameraPose('tracking-lost',26,.9,'desk-map','lost') },
    { type:'query',label:'lost-tracking',entityId:'keys' },
    { type:'pose',pose:cameraPose('wrong-map',27,.9,'different-map') },
    { type:'query',label:'wrong-map',entityId:'keys' },
    frame('reacquired',30,'passive',positions.moved,.9),
    { type:'query',label:'reacquired',entityId:'keys' },
    { type:'query',label:'never-seen',entityId:'earbuds' },
    { type:'user_report',report:{entityId:'keys',capturedAt:stamp(31),text:'I think I put the keys in a drawer.'} },
    { type:'query',label:'report-is-not-visual',entityId:'keys' },
  ];
  return { schemaVersion:2, synthetic:true, description:'Detections, camera poses and evidence are synthetic inputs; real geometry and persistent memory code execute unchanged.', entities, events };
}
