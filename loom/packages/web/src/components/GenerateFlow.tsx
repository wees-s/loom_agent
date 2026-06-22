import { useState, type CSSProperties } from "react";
import { useLoomStore } from "../store";

/* ════════════════════════════════════════════════════════════════════════
 * GenerateFlow — "✨ Gerar com IA". Describe a flow in natural language and the
 * engine's meta-agent (or the fake generator) builds a full, editable flow.
 * Self-wired to the store; the new flow arrives via flow.snapshot + auto-selects.
 * ════════════════════════════════════════════════════════════════════════ */

const BOX: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px" };

export function GenerateFlow() {
  const generateFlow = useLoomStore((s) => s.generateFlow);
  const generating = useLoomStore((s) => s.generating);
  const [prompt, setPrompt] = useState("");

  return (
    <div style={BOX} data-generate-flow>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text2)" }}>✨ Gerar com IA</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Descreva o fluxo (ex: um loop que revisa PRs e me avisa)…"
        rows={3}
        disabled={generating}
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "inherit",
          fontSize: 12,
          borderRadius: 9,
          border: "1px solid var(--line)",
          background: "var(--input)",
          color: "var(--text2)",
          padding: "8px 10px",
          resize: "vertical",
        }}
      />
      <button
        type="button"
        disabled={generating || prompt.trim().length === 0}
        onClick={() => generateFlow(prompt)}
        style={{
          padding: "8px 12px",
          border: "none",
          borderRadius: 9,
          background: "oklch(0.62 0.14 290)",
          color: "#fff",
          fontSize: 12.5,
          fontWeight: 600,
          cursor: generating ? "default" : "pointer",
          opacity: generating || prompt.trim().length === 0 ? 0.6 : 1,
        }}
      >
        {generating ? "montando seu fluxo…" : "Gerar fluxo"}
      </button>
    </div>
  );
}

export default GenerateFlow;
