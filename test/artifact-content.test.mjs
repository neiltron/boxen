import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ARTIFACT_BYTES, publishArtifact } from '../src/artifact-content.js';

const meta = { title: 'Offline network', kind: 'html' };
test('file-backed artifacts materialize bytes before saving, with no lazy file reference', async () => {
 let file = '<!doctype html><p>Native app</p>', reads = 0, saved;
 const result = await publishArtifact({ ...meta, contentPath: 'artifact-dist/network.html' }, {
  session: 's', readFile: async path => { assert.equal(path, 'artifact-dist/network.html'); reads++; return file; },
  save: async value => { saved = value; return { id: 'a', version: 1 }; },
 });
 assert.equal(reads, 1); assert.equal(result.id, 'a');
 assert.equal(saved.content, file); assert.equal(saved.session, 's');
 assert.equal('contentPath' in saved, false);
 file = null; // Sandbox sleeps/disappears: saved bytes are independent.
 assert.match(saved.content, /Native app/);
});
test('inline artifacts never read or wake the sandbox', async () => {
 const saved = await publishArtifact({ ...meta, content: 'inline' }, {
  session: 's', readFile: async () => { throw new Error('must not read'); }, save: async value => value,
 });
 assert.equal(saved.content, 'inline');
});
test('ambiguous/missing inputs, invalid paths, oversized text, and read failures do not publish', async () => {
 let saves = 0;
 const deps = { session: 's', readFile: async () => { throw new Error('missing file'); }, save: async () => { saves++; } };
 for (const args of [{}, {content:'a',contentPath:'b'}, {contentPath:''}, {contentPath:'a\0b'}]) {
  await assert.rejects(publishArtifact({ ...meta, ...args }, deps));
 }
 await assert.rejects(publishArtifact({ ...meta, contentPath:'missing' }, deps), /missing file/);
 await assert.rejects(publishArtifact({ ...meta, content:'é'.repeat(MAX_ARTIFACT_BYTES / 2 + 1) }, deps), /8 MiB/);
 assert.equal(saves, 0);
});
