#!/usr/bin/env node
// Add a Kiln result to the gallery: node scripts/add-asset.mjs <id> "<Name>" "<brief>" <asset.glb> <sheet.png> <asset.kiln.js>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [id, name, brief, glb, preview, source] = process.argv.slice(2);
if (!source) {
  console.error('usage: add-asset.mjs <id> "<Name>" "<brief>" <asset.glb> <sheet.png> <asset.kiln.js>');
  process.exit(1);
}
const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'assets');
const dir = join(assets, id);
mkdirSync(dir, { recursive: true });
const entry = { id, name, brief };
for (const [key, file] of [['glb', glb], ['preview', preview], ['source', source]]) {
  copyFileSync(file, join(dir, basename(file)));
  entry[key] = `${id}/${basename(file)}`;
}
const manifestPath = join(assets, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')).filter((a) => a.id !== id);
manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Added ${id}. Commit and push to redeploy.`);
