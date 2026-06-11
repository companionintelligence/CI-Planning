import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(_dir, '..', '..', '..', 'client', 'public');

mkdirSync(publicDir, { recursive: true });

// Valid 1x1 PNG in base64 format representing a teal dot
const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const buffer = Buffer.from(base64Png, 'base64');

writeFileSync(join(publicDir, 'icon-192.png'), buffer);
writeFileSync(join(publicDir, 'icon-512.png'), buffer);

console.log('PWA Icons written successfully to client/public/');
