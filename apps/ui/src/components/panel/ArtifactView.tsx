import { Markdown } from "@/components/Markdown";
import type { Artifact } from "@/lib/api";

// Pinned single-file Mermaid bundle verified with Subresource Integrity (SRI).
// Full build is ~3.5MB; bumps are manual (`pnpm check:mermaid` verifies the hash).
// When bumping the version, recompute the sha384 digest with:
//   curl -fsSL "<MERMAID_CDN_URL>" | openssl dgst -sha384 -binary | openssl base64 -A
const MERMAID_CDN_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js";
const MERMAID_CDN_INTEGRITY =
  "sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2";

const noReferrer = `<meta name="referrer" content="no-referrer">`;
const frameBase = `<meta charset="utf-8">${noReferrer}<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 16px; display: flex; justify-content: center; }
  svg { max-width: 100%; height: auto; }
</style>`;

function frameDoc(a: Artifact): string {
  if (a.kind === "html") {
    // srcdoc frames ignore the iframe's referrerpolicy, so the meta must be in
    // the document. After <head>, else after a leading doctype (keeps
    // standards mode), else at the start.
    const at = a.content.match(/<head(?:\s[^>]*)?>/i) ?? a.content.match(/^\s*<!doctype[^>]*>/i);
    const i = at ? at.index! + at[0].length : 0;
    return a.content.slice(0, i) + noReferrer + a.content.slice(i);
  }
  if (a.kind === "svg") return `${frameBase}${a.content}`;
  // Mermaid renders inside the sandboxed frame, from the CDN, so the app
  // bundle stays small and diagram code never runs in the app's origin. The
  // source goes in as a JSON string: mermaid reads DOM text via innerHTML,
  // which would re-escape labels like <br/> and arrows like -->.
  const source = JSON.stringify(a.content).replaceAll("<", "\\u003c");
  return `${frameBase}<div id="out"></div>
<script src="${MERMAID_CDN_URL}" integrity="${MERMAID_CDN_INTEGRITY}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script type="module">
  const out = document.getElementById("out");
  try {
    const mermaid = window.mermaid;
    if (!mermaid) throw new Error("Failed to load Mermaid diagram renderer.");
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" });
    out.innerHTML = (await mermaid.render("diagram", ${source})).svg;
  } catch (e) {
    out.textContent = String(e?.message ?? e);
  }
</script>`;
}

// html/svg/mermaid run in an opaque-origin iframe: scripts allowed, but no
// access to the app, its cookies, or its API.
export function ArtifactView({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "markdown") {
    return <div className="h-full overflow-y-auto px-6 py-5"><Markdown text={artifact.content} /></div>;
  }
  if (artifact.kind === "code") {
    return (
      <pre className="h-full overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">{artifact.content}</pre>
    );
  }
  return (
    <iframe
      title={artifact.title} sandbox="allow-scripts" srcDoc={frameDoc(artifact)}
      className="h-full w-full border-0 bg-white"
    />
  );
}
