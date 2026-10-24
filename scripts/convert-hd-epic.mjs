import fs from 'node:fs';
import path from 'node:path';
import { convertHdEpic } from '../lib/hd-epic.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--associations', '--masks', '--geometry', '--video-id', '--objects', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/convert-hd-epic.mjs --associations assoc_info.json --masks mask_info.json --geometry calibrated-clip.json --video-id VIDEO_ID [--objects ID,ID] --out recording.json');
  options[args[i].slice(2)] = args[i + 1];
}
for (const key of ['associations', 'masks', 'geometry', 'video-id', 'out']) if (!options[key]) throw new Error(`Missing --${key}`);
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const recording = convertHdEpic({ associations: read(options.associations), masks: read(options.masks), geometry: read(options.geometry), videoId: options['video-id'], objectIds: options.objects?.split(',') });
const output = path.resolve(options.out);
fs.writeFileSync(output, JSON.stringify(recording, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, objects: recording.entities.length, frames: recording.frames.length, points: recording.points.length, source: recording.source.dataset, provenance: recording.provenance }, null, 2));
