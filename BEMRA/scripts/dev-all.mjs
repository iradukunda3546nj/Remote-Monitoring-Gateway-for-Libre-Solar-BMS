#!/usr/bin/env node
/**
 * Starts the BEMRA ingestion worker, REST API and dashboard together.
 * Output of each service is prefixed; Ctrl+C stops all three.
 * Usage (from the BEMRA folder): npm start
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = [
  { name: 'worker', color: 33, cwd: 'software/backend', script: 'start:worker' },
  { name: 'api   ', color: 36, cwd: 'software/backend', script: 'start:api' },
  { name: 'web   ', color: 35, cwd: 'software/frontend', script: 'dev' },
];

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping BEMRA services…');
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // On Windows npm runs node in a child process: kill the whole tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 500);
}

for (const s of services) {
  const child = spawn(`npm run ${s.script}`, { cwd: path.join(root, s.cwd), shell: true, env: process.env });
  children.push(child);
  const tag = `\x1b[${s.color}m[${s.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) out.write(tag + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${tag}exited with code ${code}; stopping the others.`);
    stopAll(code ?? 1);
  });
}

console.log('BEMRA starting: worker + API (http://localhost:3000) + dashboard (http://localhost:5173). Ctrl+C to stop.');
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
