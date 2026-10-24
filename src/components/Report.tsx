"use client";

import { useState } from "react";
import type { RepoDiff, ReportOutput } from "@/lib/types";
import { Markdown } from "./Markdown";

export function DiffView({ patch }: { patch: string }) {
  return (
    <div className="diff">
      {patch.split("\n").map((line, i) => {
        const cls =
          line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export const fileAnchor = (role: string, path: string) => `file-${role}-${path}`.replace(/[^a-zA-Z0-9_-]/g, "_");

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

export function ReportCard({ report, diff }: { report: ReportOutput; diff: RepoDiff[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const totals = diff.flatMap((r) => r.files).reduce((t, f) => ({ a: t.a + f.additions, d: t.d + f.deletions, n: t.n + 1 }), { a: 0, d: 0, n: 0 });
  const notes = new Map(report.files.map((f) => [f.path, f.change]));

  return (
    <div className="report">
      <div className="report-head">
        <h2>Report</h2>
        <span className={`badge conf-${report.confidence}`}>{report.confidence} confidence</span>
        <span className="muted">
          {totals.n} files · <span className="adds">+{totals.a}</span> <span className="dels">−{totals.d}</span>
        </span>
      </div>
      <div className="report-body">
        <Markdown text={report.summary} />

        {report.beforeAfter.length > 0 && (
          <>
            <h4>before → after</h4>
            <table className="table">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {report.beforeAfter.map((row, i) => (
                  <tr key={i}>
                    <td className="area">{row.area}</td>
                    <td className="before">{row.before}</td>
                    <td className="after">{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h4>how it works now</h4>
        <Markdown text={report.howItWorks} />

        <h4>files changed</h4>
        {diff.map((repo) => (
          <div key={repo.role + repo.path}>
            <div className="muted" style={{ margin: "4px 0" }}>
              {repo.role} · <code>{repo.branch}</code> · {repo.path}
            </div>
            {repo.files.length === 0 && <div className="faint">no changes</div>}
            {repo.files.map((f) => {
              const id = fileAnchor(repo.role, f.path);
              return (
                <div key={id} id={id}>
                  <button className="file-row" onClick={() => toggle(id)}>
                    <span className={`st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
                    <span className="path">{f.path}</span>
                    <span className="adds">+{f.additions}</span>
                    <span className="dels">−{f.deletions}</span>
                    {notes.get(f.path) && <span className="faint">{notes.get(f.path)}</span>}
                  </button>
                  {open.has(id) && <DiffView patch={f.patch} />}
                </div>
              );
            })}
          </div>
        ))}

        {report.manualTestSteps.length > 0 && (
          <>
            <h4>try it yourself</h4>
            <ol style={{ margin: 0, paddingLeft: 22 }}>
              {report.manualTestSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </>
        )}

        {report.risks.length > 0 && (
          <>
            <h4>double-check before pushing</h4>
            <ul style={{ margin: 0, paddingLeft: 22 }}>
              {report.risks.map((r, i) => (
                <li key={i} className="warn">
                  {r}
                </li>
              ))}
            </ul>
          </>
        )}

        <h4>confidence</h4>
        <div>
          <span className={`conf-${report.confidence}`}>{report.confidence}</span>
          <span className="muted"> · {report.confidenceReason}</span>
        </div>
      </div>
    </div>
  );
}
