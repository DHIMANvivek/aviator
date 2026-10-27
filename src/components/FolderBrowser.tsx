"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Listing = {
  path: string;
  parent: string | null;
  home: string;
  roots: string[];
  git: boolean;
  folders: { name: string; path: string; git: boolean }[];
  truncated: boolean;
};

/** "/home/me/code" -> /, home, me, code; "C:\Users\me" -> C:\, Users, me. Each with its full path. */
function crumbs(p: string): { label: string; path: string }[] {
  const win = /^[A-Za-z]:[\\/]/.test(p);
  const sep = win ? "\\" : "/";
  const root = win ? p.slice(0, 3) : "/";
  const out = [{ label: root, path: root }];
  let acc = root;
  for (const part of p.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    out.push({ label: part, path: acc });
  }
  return out;
}

/**
 * A folder browser drawn in the page. The folders come from the computer running Aviator, so it
 * works from any device, while the native dialog opens on that computer's own screen.
 */
export function FolderBrowser({
  title,
  start,
  onPick,
  onClose,
}: {
  title: string;
  start?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function go(target: string | undefined, showHidden = hidden) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ path: target ?? "", hidden: showHidden ? "1" : "0" });
      const next = await api<Listing>(`/api/folders?${params}`);
      setListing(next);
      setTyped(next.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void go(start);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = listing ? (listing.path.split(/[\\/]/).filter(Boolean).pop() ?? listing.path) : "";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog folder-browser" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p className="sub">Folders on the computer running Aviator.</p>

        <div className="path-row">
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go(typed.trim())}
            aria-label="Folder path"
            spellCheck={false}
          />
          <button className="btn" onClick={() => go(typed.trim())} disabled={loading}>
            Go
          </button>
        </div>

        {listing && (
          <div className="crumbs">
            {crumbs(listing.path).map((c, i) => (
              <span key={c.path}>
                {i > 1 && <span className="faint">/</span>}
                <button className="link-btn" onClick={() => go(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
            {listing.git && <span className="chip on">git repo</span>}
          </div>
        )}

        {error && <div className="errors">{error}</div>}

        <div className="folder-list" aria-busy={loading}>
          {listing?.parent && (
            <button className="folder-row" onClick={() => go(listing.parent!)}>
              <span className="faint">↑</span> ..
            </button>
          )}
          {listing?.folders.map((f) => (
            <button key={f.path} className="folder-row" onClick={() => go(f.path)} title={f.path}>
              <span className="faint">▸</span> {f.name}
              {f.git && <span className="chip">git</span>}
            </button>
          ))}
          {listing && listing.folders.length === 0 && <div className="faint folder-empty">No folders here.</div>}
          {listing?.truncated && <div className="faint folder-empty">Only the first 2000 folders are shown; type a path above.</div>}
        </div>

        <div className="folder-tools">
          <button className="btn" onClick={() => listing && go(listing.home)} disabled={!listing}>
            Home
          </button>
          {listing && listing.roots.length > 1 && (
            <select value="" onChange={(e) => e.target.value && go(e.target.value)} aria-label="Drive">
              <option value="">Drive…</option>
              {listing.roots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <label className="faint">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                if (listing) void go(listing.path, e.target.checked);
              }}
            />{" "}
            Show hidden folders
          </label>
        </div>

        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={!listing || loading} onClick={() => listing && onPick(listing.path)}>
            Use {name ? `“${name}”` : "this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
