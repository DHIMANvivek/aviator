"use client";

import { useState } from "react";
import {
  EFFORT_LABEL,
  EFFORTS,
  STEPS,
  TOOL_CHOICES,
  WRITE_ACCESS_LABEL,
  type CustomAgent,
  type PromptVersion,
  type StepId,
  type WriteAccess,
} from "@/lib/agentPresets";
import { PLACEHOLDERS } from "@/lib/agents/prompts";
import type { Connection } from "@/lib/connectionTypes";
import type { ModelOption } from "@/lib/models";
import { AGENTS, type AgentName, type Effort } from "@/lib/types";

type Props = {
  agent: CustomAgent;
  isNew: boolean;
  models: ModelOption[];
  connections: Connection[];
  history: PromptVersion[];
  saving: boolean;
  onSave: (agent: CustomAgent, connectionIds: string[]) => void;
  onCancel: () => void;
  onDelete?: () => void;
};

export function CustomAgentEditor({ agent, isNew, models, connections, history, saving, onSave, onCancel, onDelete }: Props) {
  const [a, setA] = useState<CustomAgent>(agent);
  const [conns, setConns] = useState<string[]>(
    connections.filter((c) => c.agents.includes(agent.id) || c.tools.some((t) => t.agents.includes(agent.id))).map((c) => c.id),
  );
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const set = (patch: Partial<CustomAgent>) => setA((prev) => ({ ...prev, ...patch }));
  const setConfig = (patch: Partial<CustomAgent["config"]>) => setA((prev) => ({ ...prev, config: { ...prev.config, ...patch } }));
  const canWrite = a.tools.includes("Edit") || a.tools.includes("Write");

  function save() {
    if (!a.name.trim()) return setError("Give the agent a name.");
    if (!a.prompt.trim()) return setError("Write what the agent should do (its prompt).");
    if (a.placement.mode === "on-demand" && !a.placement.helps.length) return setError("Choose at least one agent that can call it.");
    setError("");
    onSave({ ...a, writeAccess: canWrite ? a.writeAccess : "none" }, conns);
  }

  return (
    <div className="card prompt-editor custom-editor">
      <div className="prompt-head">
        <h3 style={{ margin: 0 }}>{isNew ? "New custom agent" : `Edit ${agent.name}`}</h3>
        {!isNew && <span className="faint">id: {agent.id}</span>}
      </div>

      <div className="grid2">
        <div className="field">
          <label htmlFor="ca-name">Name</label>
          <input id="ca-name" type="text" value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="Security reviewer" />
        </div>
        <div className="field">
          <label htmlFor="ca-desc">What it&apos;s for</label>
          <input
            id="ca-desc"
            type="text"
            value={a.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Use when the work touches database migrations"
          />
          <span className="help">On-demand helpers are called when this matches the work, so be specific.</span>
        </div>
      </div>

      <div className="field">
        <label>When it runs</label>
        <div className="segmented">
          <button
            className={a.placement.mode === "step" ? "on" : ""}
            onClick={() => set({ placement: { mode: "step", step: a.placement.mode === "step" ? a.placement.step : "after-build" } })}
          >
            At a pipeline step
          </button>
          <button
            className={a.placement.mode === "on-demand" ? "on" : ""}
            onClick={() => set({ placement: { mode: "on-demand", helps: a.placement.mode === "on-demand" ? a.placement.helps : ["backend", "frontend"] } })}
          >
            When another agent needs it
          </button>
        </div>
        {a.placement.mode === "step" ? (
          <div style={{ marginTop: 8 }}>
            <select
              value={a.placement.step}
              onChange={(e) => set({ placement: { mode: "step", step: e.target.value as StepId } })}
              aria-label="Pipeline step"
            >
              {STEPS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="help" style={{ marginLeft: 10 }}>
              {STEPS.find((s) => s.id === (a.placement as { step: StepId }).step)?.hint}
            </span>
          </div>
        ) : (
          <div className="checks-row">
            <span className="help">Can be called by:</span>
            {AGENTS.map((b) => (
              <label key={b} className="check">
                <input
                  type="checkbox"
                  checked={(a.placement as { helps: AgentName[] }).helps.includes(b)}
                  onChange={(e) => {
                    const helps = (a.placement as { helps: AgentName[] }).helps;
                    set({ placement: { mode: "on-demand", helps: e.target.checked ? [...helps, b] : helps.filter((x) => x !== b) } });
                  }}
                />
                {b}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="grid4">
        <div className="field">
          <label>Model</label>
          <select value={a.config.model} onChange={(e) => setConfig({ model: e.target.value })}>
            <option value="">Plan default</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Effort</label>
          <select value={a.config.effort} onChange={(e) => setConfig({ effort: e.target.value as Effort })}>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABEL[e]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Max turns</label>
          <input type="number" min={1} max={500} value={a.config.maxTurns} onChange={(e) => setConfig({ maxTurns: Number(e.target.value) || 40 })} />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <label className="check">
            <input type="checkbox" checked={a.config.showThinking} onChange={(e) => setConfig({ showThinking: e.target.checked })} />
            show thinking
          </label>
        </div>
      </div>

      <div className="field">
        <label>Built-in tools</label>
        <div className="checks-row">
          {TOOL_CHOICES.map((t) => (
            <label key={t.name} className="check">
              <input
                type="checkbox"
                checked={a.tools.includes(t.name)}
                onChange={(e) => set({ tools: e.target.checked ? [...a.tools, t.name] : a.tools.filter((x) => x !== t.name) })}
              />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label>May change</label>
          <select value={canWrite ? a.writeAccess : "none"} disabled={!canWrite} onChange={(e) => set({ writeAccess: e.target.value as WriteAccess })}>
            {(Object.keys(WRITE_ACCESS_LABEL) as WriteAccess[]).map((w) => (
              <option key={w} value={w}>
                {WRITE_ACCESS_LABEL[w]}
              </option>
            ))}
          </select>
          <span className="help">
            {canWrite ? "Writes anywhere else are blocked." : "Read-only: give it Edit or Create files to let it change code."}
          </span>
        </div>
        <div className="field">
          <label>Connected tools it may use</label>
          {connections.length === 0 ? (
            <span className="help">
              No connections yet. Add one on the <a href="#connections">Connections</a> page.
            </span>
          ) : (
            <div className="checks-row">
              {connections.map((c) => (
                <label key={c.id} className="check">
                  <input
                    type="checkbox"
                    checked={conns.includes(c.id)}
                    onChange={(e) => setConns(e.target.checked ? [...conns, c.id] : conns.filter((x) => x !== c.id))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="ca-prompt">Prompt: what this agent does and how</label>
        <textarea id="ca-prompt" className="prompt-text" style={{ minHeight: 200 }} value={a.prompt} onChange={(e) => set({ prompt: e.target.value })} spellCheck={false} />
        <span className="help">
          Added after the rules for all agents. Placeholders: <code>{"{{ownedPaths}}"}</code> {PLACEHOLDERS["{{ownedPaths}}"]}. Step agents also
          get the task, plan and changes, and return a summary plus findings marked blocker or suggestion.
        </span>
      </div>

      {error && <div className="errors">{error}</div>}

      <div className="actions">
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : isNew ? "Create agent" : "Save agent"}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button className="btn" style={{ marginLeft: "auto", color: "var(--red)" }} onClick={onDelete}>
            Delete agent
          </button>
        )}
      </div>

      {!isNew && (
        <>
          <div className="section-label" style={{ padding: "14px 0 6px" }}>
            prompt history
          </div>
          {history.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              No earlier versions yet. Each saved prompt change keeps the previous text here.
            </div>
          ) : (
            history.map((v) => (
              <div key={v.id} className="history-row">
                <span>{new Date(v.at).toLocaleString()}</span>
                <span className="faint">{v.text.length.toLocaleString()} characters</span>
                <button className="link-btn" onClick={() => setViewing(viewing === v.id ? null : v.id)}>
                  {viewing === v.id ? "hide" : "view"}
                </button>
                <button className="link-btn" onClick={() => set({ prompt: v.text })}>
                  put back in the editor
                </button>
                {viewing === v.id && <pre className="block" style={{ width: "100%" }}>{v.text}</pre>}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
