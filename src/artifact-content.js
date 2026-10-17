// Resolve a generated file at publication time, not when the viewer opens it.
// Once save() returns, Artifacts owns the bytes and no sandbox URL is retained.
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export async function publishArtifact(args, { session, readFile, save }) {
  const inline = typeof args.content === 'string';
  const file = typeof args.contentPath === 'string';
  if (inline === file) throw new Error('Provide exactly one of content or contentPath');
  if (file && (!args.contentPath.trim() || args.contentPath.includes('\0'))) {
    throw new Error('contentPath must name a UTF-8 file in the session sandbox');
  }
  const content = file ? await readFile(args.contentPath) : args.content;
  if (typeof content !== 'string') throw new Error('Artifact content must be UTF-8 text');
  if (new TextEncoder().encode(content).byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error('Artifact exceeds the 8 MiB text limit');
  }
  // Deliberately do not persist a path, callback, URL, or other lazy dependency.
  return save({ id: args.id, session, title: args.title, kind: args.kind,
    language: args.language, content });
}
