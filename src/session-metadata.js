// Shared by HTTP and WebSocket mutations. Only these fields are user-writable.
export function validateMetadataPatch(patch) {
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) bad("expected a metadata object");
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => key !== "name" && key !== "archived")) bad("expected name and/or archived");
  const result = {};
  if ("name" in patch) {
    if (typeof patch.name !== "string") bad("name must be a string");
    result.name = patch.name.trim();
    if (!result.name || result.name.length > 120) bad("name must be 1–120 characters");
  }
  if ("archived" in patch) {
    if (typeof patch.archived !== "boolean") bad("archived must be a boolean");
    result.archived = patch.archived;
  }
  return result;
}
