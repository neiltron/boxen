#!/usr/bin/env node
// Development deploys must use the same runtime pin as the installer.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const runtime = JSON.parse(fs.readFileSync(new URL('./runtime.json', import.meta.url), 'utf8'));
const binary = process.env.BOXEN_CELLD ?? `celld-${runtime.celld.version}`;
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
const found = version.stdout?.trim().match(/^celld\s+(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
if (version.status !== 0 || found !== runtime.celld.version) {
  console.error(`Expected celld ${runtime.celld.version}; install ${binary} or set BOXEN_CELLD to that version's binary.`);
  process.exit(2);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
