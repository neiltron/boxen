#!/usr/bin/env node
// Development deploys must use the same runtime pin as the installer.
// Storage: BOXEN_S3_BUCKET / BOXEN_S3_ENDPOINT (environment or gitignored .env)
// opt into external S3/R2; otherwise the local RustFS dev store on :9000.
// `--storage-env` prints the resolved settings as shell exports for start.sh.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const LOCAL_ENDPOINT = 'http://127.0.0.1:9000';
const envFile = new URL('../.env', import.meta.url);
const config = { ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}), ...process.env };
const get = (key) => config[key] || undefined;

const rawBucket = get('BOXEN_S3_BUCKET') ?? 'pid-cells';
const configuredEndpoint = get('BOXEN_S3_ENDPOINT');
const external = Boolean(get('BOXEN_S3_BUCKET') || configuredEndpoint)
  && !/^https?:\/\/(?:127\.0\.0\.1|localhost):9000\/?$/.test(configuredEndpoint ?? '');
const storage = {
  BOXEN_STORAGE: external ? 'external' : 'local',
  BOXEN_S3_BUCKET: rawBucket.startsWith('s3://') ? rawBucket : `s3://${rawBucket}`,
  BOXEN_S3_ENDPOINT: external ? configuredEndpoint ?? '' : LOCAL_ENDPOINT,
  // Local mode always uses the RustFS dev credentials, never ambient AWS ones.
  // External mode passes through only what is configured, so profiles, SSO and
  // instance roles keep working.
  ...(external
    ? Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'].filter(get).map((k) => [k, get(k)]))
    : { AWS_ACCESS_KEY_ID: 'swarmadmin', AWS_SECRET_ACCESS_KEY: 'swarmsecret', AWS_REGION: 'us-east-1' }),
};

if (process.argv[2] === '--storage-env') {
  const quote = (v) => `'${v.replaceAll("'", `'\\''`)}'`;
  for (const [k, v] of Object.entries(storage)) console.log(`export ${k}=${quote(v)}`);
  process.exit(0);
}

const runtime = JSON.parse(fs.readFileSync(new URL('./runtime.json', import.meta.url), 'utf8'));
const binary = process.env.BOXEN_CELLD ?? `celld-${runtime.celld.version}`;
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
const found = version.stdout?.trim().match(/^celld\s+(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
if (version.status !== 0 || found !== runtime.celld.version) {
  console.error(`Expected celld ${runtime.celld.version}; install ${binary} or set BOXEN_CELLD to that version's binary.`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === 'deploy' && !args.includes('--bucket')) {
  args.push('--bucket', storage.BOXEN_S3_BUCKET);
  if (storage.BOXEN_S3_ENDPOINT) args.push('--endpoint', storage.BOXEN_S3_ENDPOINT);
}
const result = spawnSync(binary, args, { stdio: 'inherit', env: { ...process.env, ...storage } });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
