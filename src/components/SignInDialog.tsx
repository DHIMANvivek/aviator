"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { LoginStatus } from "@/lib/login";

export function SignInDialog({ onClose, onSignedIn }: { onClose: () => void; onSignedIn: () => void }) {
  const [status, setStatus] = useState<LoginStatus>({ state: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const signedIn = useRef(false);

  useEffect(() => {
    api<LoginStatus>("/api/auth/login", { method: "POST", json: { action: "start" } })
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    const poll = setInterval(() => {
      api<LoginStatus>("/api/auth/login").then(setStatus).catch(() => {});
    }, 1500);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    if (status.state === "done" && !signedIn.current) {
      signedIn.current = true;
      onSignedIn();
    }
  }, [status.state, onSignedIn]);

  async function submit() {
    setError("");
    if (!code.trim()) {
      setError("Paste the code Claude showed you first.");
      return;
    }
    try {
      setStatus(await api<LoginStatus>("/api/auth/login", { method: "POST", json: { action: "code", code } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function restart() {
    setCode("");
    setError("");
    setStatus(await api<LoginStatus>("/api/auth/login", { method: "POST", json: { action: "start" } }));
  }

  async function close() {
    if (status.state === "waiting" || status.state === "verifying") {
      await api("/api/auth/login", { method: "POST", json: { action: "cancel" } }).catch(() => {});
    }
    onClose();
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Sign in with Claude">
        <h2>Sign in with Claude</h2>
        <p className="sub">
          Uses your Claude subscription (Pro or Max) through Claude Code&apos;s own login. No API key, no extra charges.
        </p>

        {status.state === "done" ? (
          <div className="card" style={{ margin: "0 0 12px", borderColor: "var(--green)" }}>
            <span className="ok">✓ Signed in.</span> Your agents now run on your Claude plan&apos;s included usage.
          </div>
        ) : status.state === "failed" ? (
          <div className="errors">
            {status.message || "Sign-in failed."}
            <div style={{ marginTop: 8 }}>
              <button className="btn" onClick={restart}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label>1. Open the Claude sign-in page and approve access</label>
              <div>
                <button className="btn solid" disabled={!status.url} onClick={() => window.open(status.url, "_blank", "noopener")}>
                  {status.url ? "Open Claude sign-in ↗" : "Preparing sign-in…"}
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="login-code">2. Claude then shows a code. Paste it here</label>
              <input
                id="login-code"
                type="text"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Paste the code from Claude"
                autoComplete="off"
                spellCheck={false}
              />
              {(error || (status.state === "waiting" && status.message)) && (
                <span className="bad" style={{ fontSize: 12 }}>
                  {error || status.message}
                </span>
              )}
            </div>
          </>
        )}

        <div className="dialog-actions">
          {status.state === "done" ? (
            <button className="btn solid" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              {status.state !== "failed" && (
                <button className="btn solid" onClick={submit} disabled={status.state === "verifying" || !status.url}>
                  {status.state === "verifying" ? "Checking…" : "Finish sign-in"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
