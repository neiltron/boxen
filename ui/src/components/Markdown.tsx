import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Assistant text rendered as GitHub-flavored markdown. react-markdown builds
// a React tree (no innerHTML), so agent output can't inject markup; links
// open in a new tab with rel isolation. Typography comes from shadcn/typeset
// (src/typeset.css) via the wrapper classes below, so the rendered elements
// carry no classes of their own.
const components: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

// Compare the string, not mutable reducer blocks: completed prose should not
// be reparsed when another tool, the composer, or the transcript clock updates.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="typeset typeset-changelog min-w-0 max-w-[37em] break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
