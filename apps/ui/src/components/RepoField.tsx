import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { fetchBranches, fetchRepos, githubRepo, type Repo } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

// Anything that already reads as a clone URL is not a search.
const URL_LIKE = /^(https?:|ssh:|git@)/;

// Copied from boxen-legacy. The repositories the fleet's GitHub token can see,
// newest push first, narrowed by what has been typed. Fetched once per
// mount, i.e. each time the form opens. Anything pasted is used as typed.
function useRepoSearch(value: string) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [note, setNote] = useState("loading repos…");

  useEffect(() => {
    fetchRepos()
      .then((list) => { setRepos(list); setNote(list.length ? "" : "no repositories visible to the GitHub token"); })
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
  }, []);

  const q = value.trim().toLowerCase();
  const matches = URL_LIKE.test(q) ? [] : repos.filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 8);
  return { matches, note };
}

// The create form's repo field: a plain text input with the suggestions in
// a dropdown under it; picking one fills in its clone URL.
export function RepoField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { matches, note } = useRepoSearch(value);
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted, so Enter submits the form as usual; the arrow
  // keys are what turn Enter into a pick.
  const [cursor, setCursor] = useState(-1);
  const listId = useId();
  const showing = open && matches.length > 0;

  const pick = (r: Repo) => {
    onChange(r.cloneUrl);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        placeholder="git repo to clone (optional)"
        autoFocus
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setCursor(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showing) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, -1)); }
          else if (e.key === "Enter" && cursor >= 0) { e.preventDefault(); pick(matches[cursor]); }
          else if (e.key === "Escape") setOpen(false);
        }}
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={cursor >= 0 ? `${listId}-${cursor}` : undefined}
        className="font-mono text-xs"
      />
      {showing && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-0.5 max-h-56 overflow-auto border border-border bg-popover text-xs shadow-md"
        >
          {matches.map((r, i) => (
            <li key={r.fullName} id={`${listId}-${i}`} role="option" aria-selected={i === cursor}>
              {/* mousedown, not click: the input's blur would close the list first */}
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted", i === cursor && "bg-muted")}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{r.fullName}</span>
                <span className="shrink-0 text-muted-foreground">{ago(Date.parse(r.pushedAt))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p role="status" className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

// Branch suggestions for a GitHub repo, default first, as a native datalist:
// free text still works for branches that don't exist yet or other hosts.
export function BranchField({ repo, value, onChange }: { repo: string; value: string; onChange: (v: string) => void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("");
  const listId = useId();
  const fullName = githubRepo(repo);

  useEffect(() => {
    setBranches([]);
    setDefaultBranch("");
    if (!fullName) return;
    let live = true;
    const t = setTimeout(() => {
      fetchBranches(fullName).then(
        (r) => { if (live) { setBranches(r.branches); setDefaultBranch(r.defaultBranch); } },
        () => {},
      );
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [fullName]);

  return (
    <>
      <Input
        list={listId} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={defaultBranch ? `branch (default: ${defaultBranch})` : "branch (default)"}
        className="font-mono text-xs"
      />
      <datalist id={listId}>
        {branches.map((b) => <option key={b} value={b} />)}
      </datalist>
    </>
  );
}
