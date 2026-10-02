// Keep the app at its origin root: absolute assets, API calls, and HMR all
// arrive on the same host, with no path prefix to strip.
export function previewTarget(host) {
  const match = host.match(/^p(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.localhost(?::\d+)?$/i);
  return match ? { port: Number(match[1]), id: match[2].toLowerCase() } : null;
}

export function validPreviewPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3000;
}

export async function proxyPreview(request, sandbox, port) {
  try {
    // Return the actual streaming/upgrade Response: celld ties I/O to this
    // request's lifetime. Don't read the body or start a background proxy.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const headers = new Headers(request.headers);
      // Sandbox.fetch only honors wsConnect's target port for a complete
      // upgrade; otherwise it falls back to its control port. Also disallow
      // opting into the SDK's separate, token-based preview router.
      headers.set("connection", "Upgrade");
      headers.delete("x-sandbox-preview-proxy");
      headers.delete("x-sandbox-name");
      return await sandbox.wsConnect(new Request(request, { headers }), port);
    }
    return await sandbox.containerFetch(new Request(request, { redirect: "manual" }), port);
  } catch (e) {
    return new Response(`Preview unavailable on port ${port}: ${e.message}\nStart the app on 0.0.0.0 and reload.`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}

export async function listeningPorts(sandbox) {
  // /proc doesn't depend on ss being installed. bash -c keeps a failing
  // command from exiting the SDK's long-lived shell; tcp6 is optional.
  const result = await sandbox.exec("bash -c 'cat /proc/net/tcp; if [ -r /proc/net/tcp6 ]; then cat /proc/net/tcp6; fi'", { timeout: 5000 });
  if (!result.success) throw new Error(result.stderr || "Could not read listening ports");
  const ports = new Set();
  for (const line of result.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A") continue; // TCP_LISTEN, both IPv4 and IPv6
    const port = parseInt(fields[1].split(":")[1], 16);
    if (validPreviewPort(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
