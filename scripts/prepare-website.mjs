import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'apps/website/public');
mkdirSync(target, { recursive: true });
copyFileSync(resolve(root, 'scripts/install.sh'), resolve(target, 'install.sh'));
console.log('Website installer synchronized from scripts/install.sh.');
