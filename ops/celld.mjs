#!/usr/bin/env node
// Development deploys must use the same runtime pin as the installer.
// Reads optional S3/R2 settings from environment or gitignored .env, falling
// back to the zero-config local RustFS defaults (s3://pid-cells on :9000).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const runtime = JSON.parse(fs.readFileSync(new URL('./runtime.json', import.meta.url), 'utf8'));
const envFile = new URL('../.env', import.meta.url);
const dotenv = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    dotenv[match[1]] = value;
  }
}
const get = (key, fallback) => {
  const v = process.env[key] ?? dotenv[key];
  return v !== undefined && v !== '' ? v : fallback;
};

const binary = get('BOXEN_CELLD', `celld-${runtime.celld.version}`);
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
const found = version.stdout?.trim().match(/^celld\s+(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
if (version.status !== 0 || found !== runtime.celld.version) {
  console.error(`Expected celld ${runtime.celld.version}; install ${binary} or set BOXEN_CELLD to that version's binary.`);
  process.exit(2);
}

const rawBucket = get('BOXEN_S3_BUCKET', 's3://pid-cells');
const bucket = rawBucket.startsWith('s3://') ? rawBucket : `s3://${rawBucket}`;
const configuredEndpoint = process.env.BOXEN_S3_ENDPOINT ?? dotenv.BOXEN_S3_ENDPOINT;
const isExternalS3 = Boolean(
  (configuredEndpoint && !/^https?:\/\/(?:127\.0\.0\.1|localhost):9000\/?$/.test(configuredEndpoint)) ||
  process.env.BOXEN_S3_BUCKET || dotenv.BOXEN_S3_BUCKET ||
  process.env.AWS_ACCESS_KEY_ID || dotenv.AWS_ACCESS_KEY_ID
);
const endpoint = configuredEndpoint !== undefined ? configuredEndpoint : (isExternalS3 ? '' : 'http://127.0.0.1:9000');

const args = [...process.argv.slice(2)];
if (args[0] === 'deploy' && !args.includes('--bucket')) {
  args.push('--bucket', bucket);
  if (endpoint && !args.includes('--endpoint')) args.push('--endpoint', endpoint);
}

const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: get('AWS_ACCESS_KEY_ID', 'swarmadmin'),
  AWS_SECRET_ACCESS_KEY: get('AWS_SECRET_ACCESS_KEY', 'swarmsecret'),
  AWS_REGION: get('AWS_REGION', 'auto'),
};

const result = spawnSync(binary, args, { stdio: 'inherit', env });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);

