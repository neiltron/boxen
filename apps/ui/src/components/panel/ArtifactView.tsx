import { Markdown } from "@/components/Markdown";
import type { Artifact } from "@/lib/api";

const frameBase = `<meta charset="utf-8"><style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 16px; display: flex; justify-content: center; }
  svg { max-width: 100%; height: auto; }
</style>`;

function frameDoc(a: Artifact): string {
  if (a.kind === "html") return a.content;
  if (a.kind === "svg") return `${frameBase}${a.content}`;
  // Mermaid renders inside the sandboxed frame, from the CDN, so the app
  // bundle stays small and diagram code never runs in the app's origin. The
  // source goes in as a JSON string: mermaid reads DOM text via innerHTML,
  // which would re-escape labels like <br/> and arrows like -->.
  const source = JSON.stringify(a.content).replaceAll("<", "\\u003c");
  return `${frameBase}<div id="out"></div>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" });
  const out = document.getElementById("out");
  try { out.innerHTML = (await mermaid.render("diagram", ${source})).svg; }
  catch (e) { out.textContent = String(e.message ?? e); }
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
