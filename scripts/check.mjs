import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (/\.(?:mjs|js)$/.test(entry.name)) {
      execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' });
      count++;
    }
  }
}
check(root);
console.log(`Syntax checked ${count} JavaScript modules.`);
