import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/samples');

/** Returns a fresh deep copy of a sample payload. */
export function sample(name) {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8'));
}

export function listSamples(dir = '') {
  return fs.readdirSync(path.join(SAMPLES, dir)).filter((f) => f.endsWith('.json'));
}
