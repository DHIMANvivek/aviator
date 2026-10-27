"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_MAX_TURNS,
  EFFORT_LABEL,
  EFFORTS,
  matchingPreset,
  PRESETS,
  presetAgents,
  STEPS,
  type AgentConfig,
  type AgentSettings,
  type CustomAgent,
  type Placement,
  type StepId,
} from "@/lib/agentPresets";
import { fillTemplate, PLACEHOLDERS, type PromptTarget } from "@/lib/agents/prompts";
import { actorColor, api } from "@/lib/client";
import type { Connection } from "@/lib/connectionTypes";
import type { ModelOption } from "@/lib/models";
import { AGENTS, type AgentName, type Effort } from "@/lib/types";
import { CustomAgentEditor } from "./CustomAgentEditor";

const BLANK_AGENT: CustomAgent = {
  id: "",
  name: "",
  description: "",
  prompt: "",
  config: { model: "", effort: "medium", maxTurns: 40, showThinking: true },
  tools: ["Read", "Grep", "Glob"],
  writeAccess: "none",
  placement: { mode: "step", step: "after-build" },
  enabled: true,
};

function placementLabel(p: Placement): string {
  return p.mode === "step"
    ? (STEPS.find((s) => s.id === p.step)?.label ?? p.step)
    : `When ${p.helps.join(" or ") || "no agent"} needs it`;
}

/** The pipeline as a flow: built-in stages, your step agents between them, and on-demand helpers. */
function PipelineView({
  custom,
  onEdit,
  onAdd,
}: {
  custom: CustomAgent[];
  onEdit: (c: CustomAgent) => void;
  onAdd: (placement: Placement) => void;
}) {
  const at = (step: StepId) => custom.filter((c) => c.placement.mode === "step" && c.placement.step === step);
  const helpersOf = (a: AgentName) => custom.filter((c) => c.placement.mode === "on-demand" && c.placement.helps.includes(a));
  const chip = (c: CustomAgent) => (
    <button key={c.id} className={`pl-chip ${c.enabled ? "" : "off"}`} onClick={() => onEdit(c)} title={c.description}>
      {c.name}
    </button>
  );
  const stage = (label: string, agents: AgentName[]) => (
    <div className="pl-stage">
      <div>
        {agents.map((a, i) => (
          <span key={a}>
            {i > 0 && <span className="faint"> ∥ </span>}
            <span style={{ color: actorColor(a) }}>{a}</span>
          </span>
        ))}
      </div>
      <div className="faint" style={{ fontSize: 11 }}>
        {label}
      </div>
      {agents.some((a) => helpersOf(a).length) && (
        <div className="pl-helpers">
          can call: {[...new Set(agents.flatMap(helpersOf))].map(chip)}
        </div>
      )}
    </div>
  );
  const slot = (step: StepId) => (
    <div className="pl-slot" title={STEPS.find((s) => s.id === step)?.hint}>
      {at(step).map(chip)}
      <button className="pl-add" onClick={() => onAdd({ mode: "step", step })} aria-label={`Add an agent ${step}`}>
        +
      </button>
    </div>
  );
  const arrow = <span className="pl-arrow">→</span>;
  return (
    <div className="pipeline" aria-label="Pipeline">
      {stage("research", ["researcher"])}
      {arrow}
      {slot("after-research")}
      {arrow}
      {stage("plan · you approve", ["planner"])}
      {arrow}
      {slot("after-plan")}
      {arrow}
      {stage("build", ["backend", "frontend"])}
      {arrow}
      {slot("after-build")}
      {arrow}
      {stage("test & review", ["qa"])}
      {arrow}
      {slot("before-report")}
      {arrow}
      {stage("report", ["reporter"])}
    </div>
  );
}

const ROLE: Record<AgentName, string> = {
  researcher: "Reads the code, asks questions",
  planner: "Writes the plan and contract",
  backend: "Builds the API side",
  frontend: "Builds the UI side",
  qa: "Runs checks, reviews the diff",
  reporter: "Writes the before/after report",
};

const TARGET_LABEL = (t: PromptTarget) => (t === "shared" ? "Rules for all agents" : `${t} prompt`);

/** Example values so a template preview reads like the real thing. */
function preview(target: PromptTarget, text: string): string {
  const agent: AgentName = target === "shared" ? "backend" : target;
  return fillTemplate(text, agent, {
    ownedPaths: agent === "frontend" ? ["apps/web", "packages/ui"] : agent === "backend" ? ["apps/api"] : [],
    peer: agent === "backend" ? "frontend" : agent === "frontend" ? "backend" : null,
  });
}

type Loaded = {
  settings: AgentSettings;
  defaults: Record<PromptTarget, string>;
  tools: Record<AgentName, string[]>;
  templates: Omit<CustomAgent, "id" | "enabled">[];
};

export function AgentsPage({ onSaved }: { onSaved: (settings: AgentSettings) => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Record<AgentName, AgentConfig> | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<PromptTarget | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [viewing, setViewing] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [customEdit, setCustomEdit] = useState<{ agent: CustomAgent; isNew: boolean } | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const customEditor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Loaded>("/api/agents").then((d) => {
      setData(d);
      setDraft(d.settings.agents);
    });
    api<{ connections: Connection[] }>("/api/connections")
      .then((r) => setConnections(r.connections))
      .catch(() => {});
    api<{ models: ModelOption[]; error?: string }>("/api/models")
      .then((r) => {
        setModels(r.models);
        if (r.error) setModelsError(r.error);
      })
      .catch((e: Error) => setModelsError(e.message));
  }, []);

  if (!data || !draft) return <div className="muted">Loading agent settings…</div>;

  const settings = data.settings;
  const dirty = AGENTS.some((a) => JSON.stringify(draft[a]) !== JSON.stringify(settings.agents[a]));
  const preset = matchingPreset(draft);
  const promptOf = (t: PromptTarget) => settings.prompts[t] ?? data.defaults[t];
  const edited = (t: PromptTarget) => settings.prompts[t] !== undefined;

  const setAgent = (a: AgentName, patch: Partial<AgentConfig>) => setDraft({ ...draft, [a]: { ...draft[a], ...patch } });

  async function saveAgents() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await api<{ settings: AgentSettings }>("/api/agents", { method: "PUT", json: { agents: draft } });
      setData({ ...data!, settings: res.settings });
      setDraft(res.settings.agents);
      onSaved(res.settings);
      setMessage({ ok: true, text: "Saved. New runs (and agents that start from now on) use these settings." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function savePrompt(target: PromptTarget, value: string | null, note: string) {
    setSaving(true);
    try {
      const res = await api<{ settings: AgentSettings }>("/api/agents", { method: "PUT", json: { prompts: { [target]: value } } });
      setData({ ...data!, settings: res.settings });
      onSaved(res.settings);
      setText(res.settings.prompts[target] ?? data!.defaults[target]);
      setMessage({ ok: true, text: note });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  // ---------- custom agents ----------

  async function saveCustomList(list: CustomAgent[], note: string): Promise<AgentSettings | null> {
    setSaving(true);
    try {
      const res = await api<{ settings: AgentSettings }>("/api/agents", { method: "PUT", json: { custom: list } });
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      onSaved(res.settings);
      setMessage({ ok: true, text: note });
      return res.settings;
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setSaving(false);
    }
  }

  /** Give an agent access to exactly these connections (or none, with an empty list). */
  async function setAgentConnections(agentId: string, connectionIds: string[]) {
    let changed = false;
    const next = connections.map((c) => {
      const has = c.agents.includes(agentId);
      const want = connectionIds.includes(c.id);
      if (has === want) return c;
      changed = true;
      return { ...c, agents: want ? [...c.agents, agentId] : c.agents.filter((x) => x !== agentId) };
    });
    if (!changed) return;
    const res = await api<{ connections: Connection[] }>("/api/connections", { method: "PUT", json: { connections: next } });
    setConnections(res.connections);
  }

  async function saveCustom(agent: CustomAgent, connectionIds: string[]) {
    if (!customEdit || !data) return;
    const index = customEdit.isNew ? data.settings.custom.length : data.settings.custom.findIndex((c) => c.id === customEdit.agent.id);
    const list = [...data.settings.custom];
    list.splice(index, customEdit.isNew ? 0 : 1, agent);
    const saved = await saveCustomList(list, customEdit.isNew ? `Created ${agent.name}. New runs include it.` : `Saved ${agent.name}.`);
    if (!saved) return;
    await setAgentConnections(saved.custom[index].id, connectionIds).catch((e: Error) => setMessage({ ok: false, text: e.message }));
    setCustomEdit(null);
  }

  async function deleteCustom(c: CustomAgent) {
    if (!data || !window.confirm(`Delete the custom agent "${c.name}"?`)) return;
    const saved = await saveCustomList(data.settings.custom.filter((x) => x.id !== c.id), `Deleted ${c.name}.`);
    if (saved) await setAgentConnections(c.id, []).catch(() => {});
    setCustomEdit(null);
  }

  function moveCustom(i: number, dir: -1 | 1) {
    if (!data) return;
    const list = [...data.settings.custom];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    void saveCustomList(list, "Order saved. Agents at the same step run in this order.");
  }

  function startCustom(from: Partial<CustomAgent>) {
    setEditing(null);
    setCustomEdit({ agent: { ...BLANK_AGENT, ...from, id: "" }, isNew: true });
    setTimeout(() => customEditor.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function editCustom(c: CustomAgent) {
    setEditing(null);
    setCustomEdit({ agent: c, isNew: false });
    setTimeout(() => customEditor.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function openEditor(t: PromptTarget) {
    setCustomEdit(null);
    setEditing(t);
    setText(promptOf(t));
    setMode("edit");
    setViewing(null);
    setMessage(null);
    setTimeout(() => editor.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  const modelOptions = (current: string) => {
    const list = models ?? [];
    const known = current === "" || list.some((m) => m.value === current);
    return (
      <>
        <option value="">Plan default</option>
        {list.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {m.label}
          </option>
        ))}
        {!known && <option value={current}>{current}</option>}
      </>
    );
  };

  const effortWarning = (a: AgentName) => {
    const m = models?.find((x) => x.value === draft[a].model);
    if (!m?.efforts) return null;
    if (m.efforts.length === 0) return "This model ignores effort.";
    return m.efforts.includes(draft[a].effort) ? null : `${m.label} doesn't support ${EFFORT_LABEL[draft[a].effort]}.`;
  };

  const history = editing ? settings.history.filter((v) => v.target === editing) : [];
  const editorDirty = editing ? text !== promptOf(editing) : false;

  return (
    <div className="agents-page">
      <h2 className="page-title">Agents</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        How hard each agent thinks, which model it uses, and exactly what it&apos;s told. Applies to every project.
      </p>

      <div className="section-label" style={{ padding: "8px 0 6px" }}>
        pipeline · click an agent to edit it, + to add one at that point
      </div>
      <PipelineView custom={settings.custom} onEdit={editCustom} onAdd={(placement) => startCustom({ placement })} />

      <div className="section-label" style={{ padding: "8px 0 6px" }}>
        preset
      </div>
      <div className="segmented">
        {PRESETS.map((p) => (
          <button key={p.id} className={preset === p.id ? "on" : ""} onClick={() => setDraft(presetAgents(p, draft))}>
            {p.name}
            {p.id === "balanced" ? " (recommended)" : ""}
          </button>
        ))}
        <button className={preset === "custom" ? "on" : ""} disabled title="Change any effort below to make a custom setup">
          Custom
        </button>
      </div>
      <div className="help muted" style={{ margin: "6px 0 14px", fontSize: 12 }}>
        {PRESETS.find((p) => p.id === preset)?.description ?? "Your own mix of settings."} Presets set effort; your model and
        turn choices are kept. Higher effort uses more of your plan.
      </div>

      <table className="table agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Model</th>
            <th>Effort</th>
            <th title="How many steps the agent may take in one go. A step is one Claude reply plus the tools it calls (reading a file, running a command…). When it reaches the limit it stops where it is, so raise it if an agent keeps stopping before it finishes." style={{ cursor: "help" }}>Max turns ⓘ</th>
            <th>Thinking</th>
            <th>Prompt</th>
          </tr>
        </thead>
        <tbody>
          {AGENTS.map((a) => (
            <tr key={a}>
              <td>
                <div style={{ color: actorColor(a), fontWeight: 500 }}>{a}</div>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  {ROLE[a]} · tools: {data.tools[a].join(", ")}
                </div>
              </td>
              <td>
                <select value={draft[a].model} onChange={(e) => setAgent(a, { model: e.target.value })} aria-label={`${a} model`}>
                  {modelOptions(draft[a].model)}
                </select>
              </td>
              <td>
                <select
                  value={draft[a].effort}
                  onChange={(e) => setAgent(a, { effort: e.target.value as Effort })}
                  aria-label={`${a} effort`}
                >
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {EFFORT_LABEL[e]}
                    </option>
                  ))}
                </select>
                {effortWarning(a) && <div className="warn" style={{ fontSize: 11 }}>{effortWarning(a)}</div>}
              </td>
              <td>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={draft[a].maxTurns}
                  onChange={(e) => setAgent(a, { maxTurns: Number(e.target.value) || DEFAULT_MAX_TURNS[a] })}
                  aria-label={`${a} max turns`}
                  style={{ width: 72 }}
                />
              </td>
              <td>
                <label className="check" style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={draft[a].showThinking} onChange={(e) => setAgent(a, { showThinking: e.target.checked })} />
                  show
                </label>
              </td>
              <td>
                <button className="btn" onClick={() => openEditor(a)}>
                  {edited(a) ? "Edit (changed)" : "View / edit"}
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={5}>
              <div style={{ fontWeight: 500 }}>Rules for all agents</div>
              <div className="faint" style={{ fontSize: 11.5 }}>
                Added to every agent&apos;s prompt, before its role
              </div>
            </td>
            <td>
              <button className="btn" onClick={() => openEditor("shared")}>
                {edited("shared") ? "Edit (changed)" : "View / edit"}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {modelsError && <div className="faint" style={{ fontSize: 12 }}>Couldn&apos;t list your plan&apos;s models ({modelsError}); &quot;Plan default&quot; always works.</div>}

      <div className="save-bar">
        <button className="btn solid" disabled={!dirty || saving} onClick={saveAgents}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button className="btn" disabled={!dirty || saving} onClick={() => setDraft(settings.agents)}>
          Discard
        </button>
        {message && <span className={message.ok ? "ok" : "bad"}>{message.text}</span>}
      </div>

      <div className="custom-head">
        <h2 className="page-title" style={{ margin: 0 }}>
          Custom agents
        </h2>
        <select
          className="template-select"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v === "blank") startCustom({});
            else if (v) startCustom(data.templates[Number(v)]);
          }}
          aria-label="New custom agent"
        >
          <option value="">+ New agent…</option>
          <option value="blank">Blank agent</option>
          {data.templates.map((t, i) => (
            <option key={t.name} value={i}>
              From template: {t.name}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>
        Your own small agents. Put one at a pipeline step (e.g. a security review after building), or let other agents call it when
        they need it (e.g. a test writer). Each has its own prompt, model, tools, folders and connected tools.
      </p>
      {settings.custom.length === 0 ? (
        <div className="faint" style={{ marginBottom: 16 }}>
          No custom agents yet. Start from a template above.
        </div>
      ) : (
        <table className="table agents-table">
          <thead>
            <tr>
              <th>On</th>
              <th>Agent</th>
              <th>When it runs</th>
              <th>Model · effort</th>
              <th>Tools</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {settings.custom.map((c, i) => (
              <tr key={c.id} style={c.enabled ? undefined : { opacity: 0.55 }}>
                <td>
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    aria-label={`${c.name} enabled`}
                    onChange={() =>
                      saveCustomList(
                        settings.custom.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)),
                        `${c.name} ${c.enabled ? "turned off" : "turned on"}.`,
                      )
                    }
                  />
                </td>
                <td>
                  <div style={{ color: actorColor(c.id), fontWeight: 500 }}>{c.name}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>
                    {c.description}
                  </div>
                </td>
                <td style={{ fontSize: 12 }}>{placementLabel(c.placement)}</td>
                <td style={{ fontSize: 12 }}>
                  {c.config.model ? (models?.find((m) => m.value === c.config.model)?.label ?? c.config.model) : "plan default"} ·{" "}
                  {EFFORT_LABEL[c.config.effort]}
                </td>
                <td className="faint" style={{ fontSize: 11.5 }}>
                  {c.tools.join(", ")}
                  {c.writeAccess !== "none" && c.tools.some((t) => t === "Edit" || t === "Write") ? ` · writes ${c.writeAccess}` : " · read-only"}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn icon" onClick={() => moveCustom(i, -1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </button>{" "}
                  <button className="btn icon" onClick={() => moveCustom(i, 1)} disabled={i === settings.custom.length - 1} aria-label="Move down">
                    ↓
                  </button>{" "}
                  <button className="btn" onClick={() => editCustom(c)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {customEdit && (
        <div ref={customEditor}>
          <CustomAgentEditor
            key={customEdit.agent.id || "new"}
            agent={customEdit.agent}
            isNew={customEdit.isNew}
            models={models ?? []}
            connections={connections}
            history={settings.history.filter((v) => v.target === `custom:${customEdit.agent.id}`)}
            saving={saving}
            onSave={saveCustom}
            onCancel={() => setCustomEdit(null)}
            onDelete={customEdit.isNew ? undefined : () => deleteCustom(customEdit.agent)}
          />
        </div>
      )}

      {editing && (
        <div className="card prompt-editor" ref={editor}>
          <div className="prompt-head">
            <h3 style={{ margin: 0 }}>{TARGET_LABEL(editing)}</h3>
            <span className={`badge ${edited(editing) ? "warn" : "muted"}`}>{edited(editing) ? "changed" : "default"}</span>
            <div className="segmented" style={{ marginLeft: "auto" }}>
              <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>
                Edit
              </button>
              <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>
                Preview
              </button>
            </div>
          </div>

          <div className="layers">
            What {editing === "shared" ? "every agent" : `the ${editing}`} receives, in order:{" "}
            <span className="layer">1. Claude Code&apos;s base prompt (built in)</span> →{" "}
            <span className={`layer ${editing === "shared" ? "here" : ""}`}>2. Rules for all agents</span> →{" "}
            <span className={`layer ${editing !== "shared" ? "here" : ""}`}>3. {editing === "shared" ? "Each agent's role" : "This role"}</span> →{" "}
            <span className="layer">4. Your repo&apos;s CLAUDE.md</span>. Then each run adds the task message, shown in the run as
            &quot;Instructions&quot;.
          </div>

          {mode === "edit" ? (
            <textarea className="prompt-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={20} />
          ) : (
            <pre className="block prompt-preview">{preview(editing, text)}</pre>
          )}

          <div className="faint" style={{ fontSize: 11.5, margin: "4px 0 8px" }}>
            Placeholders:{" "}
            {Object.entries(PLACEHOLDERS).map(([k, v]) => (
              <span key={k} style={{ marginRight: 12 }}>
                <code>{k}</code> {v}
              </span>
            ))}
            {editing === "shared" && (
              <div style={{ marginTop: 4 }}>
                Safety is enforced in code too: even if you remove a rule here, git push, .env reads and writes outside an agent&apos;s
                folders stay blocked.
              </div>
            )}
          </div>

          <div className="actions">
            <button className="btn solid" disabled={!editorDirty || saving || !text.trim()} onClick={() => savePrompt(editing, text, "Prompt saved. New agents use it from now on.")}>
              Save prompt
            </button>
            <button
              className="btn"
              disabled={!edited(editing) || saving}
              onClick={() =>
                window.confirm(`Reset the ${TARGET_LABEL(editing)} to Aviator's default? Your current text stays in history.`) &&
                savePrompt(editing, null, "Reset to the default. Your previous text is in history.")
              }
            >
              Reset to default
            </button>
            <button className="btn" disabled={!editorDirty} onClick={() => setText(promptOf(editing))}>
              Undo unsaved edits
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              Close
            </button>
          </div>

          <div className="section-label" style={{ padding: "14px 0 6px" }}>
            history
          </div>
          {history.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              No earlier versions yet. Each save keeps the previous text here.
            </div>
          ) : (
            history.map((v) => (
              <div key={v.id} className="history-row">
                <span>{new Date(v.at).toLocaleString()}</span>
                <span className="faint">{v.text.length.toLocaleString()} characters</span>
                <button className="link-btn" onClick={() => setViewing(viewing === v.id ? null : v.id)}>
                  {viewing === v.id ? "hide" : "view"}
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    window.confirm("Restore this version? The current text is kept in history.") &&
                    savePrompt(editing, v.text, "Restored that version. The text it replaced is in history.")
                  }
                >
                  restore
                </button>
                {viewing === v.id && <pre className="block" style={{ width: "100%" }}>{v.text}</pre>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
