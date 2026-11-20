import { Markdown } from "@/components/Markdown";
import type { Artifact } from "@/lib/api";
import { useIsDark } from "@/lib/theme";

// Pass the parent's resolved color scheme into the iframe explicitly: Safari
// does not propagate parent color-scheme into iframes, and prefers-color-scheme
// inside the frame ignores manual theme overrides.
function frameBase(dark: boolean): string {
  const scheme = dark ? "dark" : "light";
  return `<meta charset="utf-8"><meta name="color-scheme" content="${scheme}"><style>
  :root { color-scheme: ${scheme}; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 16px; display: flex; justify-content: center; }
  svg { max-width: 100%; height: auto; }
</style>`;
}

function frameDoc(a: Artifact, dark: boolean): string {
  if (a.kind === "html") return a.content;
  const base = frameBase(dark);
  if (a.kind === "svg") return `${base}${a.content}`;
  // Mermaid renders inside the sandboxed frame, from the CDN, so the app
  // bundle stays small and diagram code never runs in the app's origin. The
  // source goes in as a JSON string: mermaid reads DOM text via innerHTML,
  // which would re-escape labels like <br/> and arrows like -->.
  const source = JSON.stringify(a.content).replaceAll("<", "\\u003c");
  const theme = dark ? "dark" : "default";
  return `${base}<div id="out"></div>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(theme)} });
  const out = document.getElementById("out");
  try { out.innerHTML = (await mermaid.render("diagram", ${source})).svg; }
  catch (e) { out.textContent = String(e.message ?? e); }
</script>`;
}

// html/svg/mermaid run in an opaque-origin iframe: scripts allowed, but no
// access to the app, its cookies, or its API.
export function ArtifactView({ artifact }: { artifact: Artifact }) {
  const dark = useIsDark();
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
      title={artifact.title}
      sandbox="allow-scripts"
      srcDoc={frameDoc(artifact, dark)}
      className={`h-full w-full border-0 ${artifact.kind === "html" ? "bg-white" : "bg-background"}`}
    />
  );
}
