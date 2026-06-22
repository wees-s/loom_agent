import { type CSSProperties, useState } from "react";
import type { TriggerConfig, NodeTypeDef, ModelDef } from "@loom/shared";
import { useLoomStore, composeSchedule } from "../store";

/* ════════════════════════════════════════════════════════════════════════
 * CanvasOverlay — on-canvas controls ported 1:1 from Loom.dc.html lines
 * ~175-338. Contains:
 *   1. "Adicionar agente" button  (position:absolute top-left, edit mode)
 *   2. Full add-agent panel with:
 *      • Tipo: 4 recommended Padrões + "Tipos avançados" expander (search +
 *        8 NODE_TYPE_CATALOG groups)
 *      • Nome, Função inputs
 *      • Modelo chips from MODEL_CATALOG
 *      • Trigger config block (Trigger type only): kind pills +
 *        conditional freq/time/interval/event controls + schedule preview
 *      • Gatilho text input (non-Trigger types)
 *      • Prompt textarea
 *      • "Criar agente" button
 *   3. Bottom-left canvas hint text pill
 *   4. Bottom-right zoom controls (- / fit% / +)
 *
 * All state is owned by the zustand store; component-local state is limited
 * to transient hover flags (allowed by the contract).
 * ════════════════════════════════════════════════════════════════════════ */

const ACCENT = "oklch(0.62 0.14 160)";

function alpha(c: string, a: number): string {
  return c.replace(")", ` / ${a})`);
}

/* ── Reusable pill button used in several sub-sections ── */
interface PillBtnProps {
  active: boolean;
  activeColor?: string;
  onClick: () => void;
  children: React.ReactNode;
  style?: CSSProperties;
}
function PillBtn({ active, activeColor, onClick, children, style }: PillBtnProps) {
  const col = activeColor ?? ACCENT;
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 11px",
        border: `1px solid ${active ? alpha(col, 0.35) : "var(--line)"}`,
        borderRadius: 999,
        background: active ? alpha(col, 0.12) : "transparent",
        cursor: "pointer",
        fontFamily: "'Hanken Grotesk',sans-serif",
        fontSize: 11.5,
        fontWeight: 600,
        color: active ? col : "var(--text2)",
        transition: "all .15s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* ── Type card button for the "Padrões" 2×2 grid ── */
interface TypeCardProps {
  def: NodeTypeDef;
  active: boolean;
  onPick: () => void;
}
function TypeCard({ def, active, onPick }: TypeCardProps) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={def.desc}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "8px 10px",
        border: `1px solid ${active ? alpha(def.color, 0.4) : hov ? alpha(def.color, 0.25) : "var(--line)"}`,
        borderRadius: 9,
        background: active ? alpha(def.color, 0.13) : hov ? alpha(def.color, 0.07) : "var(--fill)",
        cursor: "pointer",
        fontFamily: "'Hanken Grotesk',sans-serif",
        fontSize: 12,
        fontWeight: 600,
        color: "var(--text)",
        textAlign: "left",
        transition: "all .15s",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: def.color,
          flexShrink: 0,
        }}
      />
      {def.type}
    </button>
  );
}

/* ── Chip button for advanced type picker ── */
interface AdvChipProps {
  def: NodeTypeDef;
  active: boolean;
  onPick: () => void;
}
function AdvChip({ def, active, onPick }: AdvChipProps) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onPick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={def.desc}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 9px",
        border: `1px solid ${active ? alpha(def.color, 0.4) : hov ? alpha(def.color, 0.22) : "var(--line)"}`,
        borderRadius: 999,
        background: active ? alpha(def.color, 0.12) : hov ? alpha(def.color, 0.06) : "transparent",
        cursor: "pointer",
        fontFamily: "'Hanken Grotesk',sans-serif",
        fontSize: 11,
        fontWeight: 500,
        color: "var(--text2)",
        transition: "all .15s",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: def.color,
          flexShrink: 0,
        }}
      />
      {def.type}
    </button>
  );
}

/* ── Model chip ── */
interface ModelChipProps {
  def: ModelDef;
  active: boolean;
  onPick: () => void;
}
function ModelChip({ def, active, onPick }: ModelChipProps) {
  return (
    <button
      onClick={onPick}
      style={{
        padding: "6px 10px",
        border: `1px solid ${active ? alpha(ACCENT, 0.4) : "var(--line)"}`,
        borderRadius: 999,
        background: active ? alpha(ACCENT, 0.12) : "transparent",
        cursor: "pointer",
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 10.5,
        color: active ? ACCENT : "var(--text3)",
        transition: "all .15s",
      }}
    >
      {def.label}
    </button>
  );
}

/* ── Trigger config block (shared between create panel) ── */
interface TriggerBlockProps {
  trigger: TriggerConfig;
  onChange: (patch: Partial<TriggerConfig>) => void;
}
function TriggerBlock({ trigger, onChange }: TriggerBlockProps) {
  const KINDS: TriggerConfig["kind"][] = ["Agendado", "Intervalo", "Webhook", "Manual"];
  const FREQS = ["Diário", "Dias úteis", "Semanal", "Mensal"] as const;
  const INTERVALS = ["30 s", "1 min", "5 min", "15 min", "1 h", "6 h"] as const;

  const schedulePreview = composeSchedule(trigger);

  return (
    <div
      style={{
        padding: 13,
        borderRadius: 12,
        background: "oklch(0.95 0.03 160 / 0.5)",
        border: "1px solid oklch(0.8 0.06 160 / 0.4)",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "#5a7a6c",
          }}
        >
          Gatilho
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9,
            color: "#fff",
            background: "oklch(0.58 0.12 160)",
            padding: "2px 7px",
            borderRadius: 999,
          }}
        >
          obrigatório
        </span>
      </div>

      {/* kind pills */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 11 }}>
        {KINDS.map((k) => (
          <PillBtn
            key={k}
            active={trigger.kind === k}
            activeColor="oklch(0.58 0.12 160)"
            onClick={() => onChange({ kind: k })}
          >
            {k}
          </PillBtn>
        ))}
      </div>

      {/* Agendado branch */}
      {trigger.kind === "Agendado" && (
        <>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 6,
            }}
          >
            Frequência
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
            {FREQS.map((f) => (
              <button
                key={f}
                onClick={() => onChange({ freq: f })}
                style={{
                  padding: "5px 10px",
                  border: `1px solid ${trigger.freq === f ? alpha(ACCENT, 0.35) : "var(--line)"}`,
                  borderRadius: 999,
                  background: trigger.freq === f ? alpha(ACCENT, 0.12) : "transparent",
                  cursor: "pointer",
                  fontFamily: "'Hanken Grotesk',sans-serif",
                  fontSize: 11,
                  color: trigger.freq === f ? ACCENT : "var(--text2)",
                  transition: "all .15s",
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 6,
            }}
          >
            Horário
          </div>
          <input
            type="text"
            value={trigger.time ?? "09:00"}
            placeholder="09:00"
            onChange={(e) => onChange({ time: e.target.value })}
            style={{
              width: "100%",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12,
              color: "var(--text2)",
              background: "var(--glass)",
              border: "1px solid var(--line)",
              borderRadius: 9,
              padding: "8px 10px",
              outline: "none",
            }}
          />
        </>
      )}

      {/* Intervalo branch */}
      {trigger.kind === "Intervalo" && (
        <>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 6,
            }}
          >
            Executar a cada
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {INTERVALS.map((iv) => (
              <button
                key={iv}
                onClick={() => onChange({ interval: iv })}
                style={{
                  padding: "5px 10px",
                  border: `1px solid ${trigger.interval === iv ? alpha(ACCENT, 0.35) : "var(--line)"}`,
                  borderRadius: 999,
                  background: trigger.interval === iv ? alpha(ACCENT, 0.12) : "transparent",
                  cursor: "pointer",
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11,
                  color: trigger.interval === iv ? ACCENT : "var(--text2)",
                  transition: "all .15s",
                }}
              >
                {iv}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Webhook branch */}
      {trigger.kind === "Webhook" && (
        <>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 6,
            }}
          >
            Evento / endpoint
          </div>
          <input
            type="text"
            value={trigger.event ?? ""}
            placeholder="ex: github.push"
            onChange={(e) => onChange({ event: e.target.value })}
            style={{
              width: "100%",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11,
              color: "var(--text2)",
              background: "var(--glass)",
              border: "1px solid var(--line)",
              borderRadius: 9,
              padding: "8px 10px",
              outline: "none",
            }}
          />
        </>
      )}

      {/* Manual branch */}
      {trigger.kind === "Manual" && (
        <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.4 }}>
          Disparado manualmente por você ou por outro agente.
        </div>
      )}

      {/* schedule preview */}
      <div
        style={{
          marginTop: 11,
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 10,
          color: "#5a7a6c",
        }}
      >
        <span style={{ opacity: 0.7 }}>agenda:</span>
        <span style={{ fontWeight: 500 }}>{schedulePreview}</span>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Add-agent panel
 * ════════════════════════════════════════════════════════════════════════ */
function AddAgentPanel() {
  const draft = useLoomStore((s) => s.draft);
  const advOpen = useLoomStore((s) => s.advOpen);
  const typeQuery = useLoomStore((s) => s.typeQuery);
  const catalog = useLoomStore((s) => s.catalog);
  const models = useLoomStore((s) => s.models);

  const closeAdd = useLoomStore((s) => s.closeAdd);
  const setDraft = useLoomStore((s) => s.setDraft);
  const setDraftTrigger = useLoomStore((s) => s.setDraftTrigger);
  const pickDraftType = useLoomStore((s) => s.pickDraftType);
  const toggleAdv = useLoomStore((s) => s.toggleAdv);
  const setTypeQuery = useLoomStore((s) => s.setTypeQuery);
  const createAgent = useLoomStore((s) => s.createAgent);

  if (!draft) return null;

  // 4 recommended Padrões
  const stdTypes = catalog.filter((d) => d.recommended);

  // Advanced groups (exclude Padrões category, filter by typeQuery)
  const query = typeQuery.trim().toLowerCase();
  const advCatalog = catalog.filter((d) => !d.recommended);
  const filtered = query
    ? advCatalog.filter(
        (d) =>
          d.type.toLowerCase().includes(query) ||
          d.category.toLowerCase().includes(query) ||
          d.desc.toLowerCase().includes(query),
      )
    : advCatalog;

  // Group filtered by category
  const groupMap = new Map<string, NodeTypeDef[]>();
  for (const d of filtered) {
    const arr = groupMap.get(d.category) ?? [];
    arr.push(d);
    groupMap.set(d.category, arr);
  }
  const advGroups = Array.from(groupMap.entries()).map(([name, items]) => ({ name, items }));

  const isTrigger = draft.type === "Trigger";
  const accentGlow = alpha(ACCENT, 0.55);

  return (
    <div
      style={{
        position: "absolute",
        left: 14,
        top: 14,
        zIndex: 7,
        width: 298,
        maxHeight: "calc(100% - 28px)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 16,
        borderRadius: 16,
        background: "var(--glass)",
        backdropFilter: "blur(22px) saturate(1.4)",
        WebkitBackdropFilter: "blur(22px) saturate(1.4)",
        border: "1px solid var(--glass-border)",
        boxShadow: "0 18px 48px -14px rgba(30,55,45,0.32)",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "-.02em",
            color: "var(--text)",
          }}
        >
          Novo agente
        </span>
        <button
          onClick={closeAdd}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: "none",
            borderRadius: 8,
            background: "var(--fill)",
            color: "var(--text3)",
            fontSize: 15,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--line2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--fill)";
          }}
        >
          &times;
        </button>
      </div>

      {/* ── Tipo section ── */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 7,
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9.5,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            Tipo
          </span>
          <span style={{ fontSize: 10, color: "var(--muted)" }}>passe o mouse p/ descrição</span>
        </div>

        {/* Padrões header */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: ACCENT,
            }}
          />
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)" }}>Padrões</span>
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9.5,
              color: "var(--muted)",
            }}
          >
            recomendados
          </span>
        </div>

        {/* 2×2 grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {stdTypes.map((d) => (
            <TypeCard
              key={d.type}
              def={d}
              active={draft.type === d.type}
              onPick={() => pickDraftType(d.type)}
            />
          ))}
        </div>

        {/* Tipos avançados toggle */}
        <button
          onClick={toggleAdv}
          style={{
            marginTop: 9,
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "8px 10px",
            border: "1px dashed var(--line)",
            borderRadius: 9,
            background: "var(--glass)",
            cursor: "pointer",
            fontFamily: "'Hanken Grotesk',sans-serif",
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--text3)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--fill)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--glass)";
          }}
        >
          {advOpen ? "▲ Ocultar tipos avançados" : "▾ Tipos avançados"}
        </button>

        {/* Advanced section */}
        {advOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 11 }}>
            <input
              type="text"
              value={typeQuery}
              onChange={(e) => setTypeQuery(e.target.value)}
              placeholder="Buscar tipo de agente..."
              style={{
                width: "100%",
                fontFamily: "'Hanken Grotesk',sans-serif",
                fontSize: 12,
                color: "var(--text2)",
                background: "var(--input)",
                border: "1px solid var(--line)",
                borderRadius: 9,
                padding: "8px 11px",
                outline: "none",
              }}
            />
            {advGroups.map((grp) => (
              <div key={grp.name}>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 9,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: "var(--muted)",
                    marginBottom: 6,
                  }}
                >
                  {grp.name}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {grp.items.map((it) => (
                    <AdvChip
                      key={it.type}
                      def={it}
                      active={draft.type === it.type}
                      onPick={() => pickDraftType(it.type)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Nome ── */}
      <div>
        <div
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--muted)",
            marginBottom: 7,
          }}
        >
          Nome
        </div>
        <input
          type="text"
          value={draft.name}
          placeholder="Nome do agente"
          onChange={(e) => setDraft({ name: e.target.value })}
          style={{
            width: "100%",
            fontFamily: "'Hanken Grotesk',sans-serif",
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text)",
            background: "var(--input)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: "9px 11px",
            outline: "none",
          }}
        />
      </div>

      {/* ── Função ── */}
      <div>
        <div
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--muted)",
            marginBottom: 7,
          }}
        >
          Função
        </div>
        <input
          type="text"
          value={draft.role}
          placeholder="O que este agente faz"
          onChange={(e) => setDraft({ role: e.target.value })}
          style={{
            width: "100%",
            fontFamily: "'Hanken Grotesk',sans-serif",
            fontSize: 13,
            color: "var(--text2)",
            background: "var(--input)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: "9px 11px",
            outline: "none",
          }}
        />
      </div>

      {/* ── Modelo ── */}
      <div>
        <div
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--muted)",
            marginBottom: 8,
          }}
        >
          Modelo
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {models.map((m) => (
            <ModelChip
              key={m.id}
              def={m}
              active={draft.model === m.id}
              onPick={() => setDraft({ model: m.id })}
            />
          ))}
        </div>
      </div>

      {/* ── Trigger config block (only for Trigger type) ── */}
      {isTrigger ? (
        <TriggerBlock trigger={draft.trigger} onChange={(patch) => setDraftTrigger(patch)} />
      ) : (
        /* ── Gatilho text (non-Trigger types) ── */
        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9.5,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 7,
            }}
          >
            Gatilho
          </div>
          <input
            type="text"
            value={draft.schedule}
            placeholder="ex: ao receber do Scribe"
            onChange={(e) => setDraft({ schedule: e.target.value })}
            style={{
              width: "100%",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11,
              color: "var(--text2)",
              background: "var(--input)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: "9px 11px",
              outline: "none",
            }}
          />
        </div>
      )}

      {/* ── Prompt ── */}
      <div>
        <div
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--muted)",
            marginBottom: 7,
          }}
        >
          Prompt
        </div>
        <textarea
          value={draft.prompt}
          placeholder="Instruções completas do agente..."
          onChange={(e) => setDraft({ prompt: e.target.value })}
          style={{
            width: "100%",
            minHeight: 120,
            resize: "vertical",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 11,
            lineHeight: 1.6,
            color: "var(--text2)",
            background: "var(--input)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: "10px 11px",
            outline: "none",
          }}
        />
      </div>

      {/* ── Criar agente ── */}
      <button
        onClick={createAgent}
        style={{
          width: "100%",
          padding: 11,
          border: "none",
          borderRadius: 11,
          background: ACCENT,
          color: "#fff",
          fontFamily: "'Hanken Grotesk',sans-serif",
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: `0 8px 20px -8px ${accentGlow}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.filter = "brightness(1.06)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.filter = "";
        }}
      >
        Criar agente
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * "Adicionar agente" button (shown in edit mode when panel is closed)
 * ════════════════════════════════════════════════════════════════════════ */
function AddButton() {
  const openAdd = useLoomStore((s) => s.openAdd);
  const [hov, setHov] = useState(false);

  return (
    <button
      onClick={openAdd}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: "absolute",
        left: 14,
        top: 14,
        zIndex: 6,
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "10px 13px",
        border: "1px solid var(--glass-border)",
        borderRadius: 12,
        background: hov ? "#fff" : "var(--glass)",
        backdropFilter: "blur(16px) saturate(1.3)",
        WebkitBackdropFilter: "blur(16px) saturate(1.3)",
        boxShadow: "0 8px 26px -10px rgba(30,55,45,0.24)",
        cursor: "pointer",
        fontFamily: "'Hanken Grotesk',sans-serif",
        fontSize: 13,
        fontWeight: 600,
        color: "var(--text)",
        transition: "background .15s",
      }}
    >
      Adicionar agente
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: 7,
          background: ACCENT,
          color: "#fff",
          fontSize: 15,
          lineHeight: 1,
        }}
      >
        +
      </span>
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Zoom controls (bottom-right)
 * ════════════════════════════════════════════════════════════════════════ */
function ZoomControls() {
  const zoom = useLoomStore((s) => s.zoom);
  const zoomBy = useLoomStore((s) => s.zoomBy);
  const resetView = useLoomStore((s) => s.resetView);

  const zoomPct = Math.round((zoom ?? 1) * 100);

  return (
    <div
      style={{
        position: "absolute",
        right: 14,
        bottom: 14,
        zIndex: 6,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 4,
        borderRadius: 11,
        background: "var(--glass)",
        backdropFilter: "blur(16px) saturate(1.3)",
        WebkitBackdropFilter: "blur(16px) saturate(1.3)",
        border: "1px solid var(--glass-border)",
        boxShadow: "0 8px 24px -10px var(--shadow)",
      }}
    >
      <ZoomBtn title="Diminuir zoom" onClick={() => zoomBy(-0.2)}>
        &minus;
      </ZoomBtn>
      <button
        onClick={resetView}
        title="Ajustar à tela"
        style={{
          minWidth: 46,
          height: 28,
          border: "none",
          borderRadius: 8,
          background: "transparent",
          color: "var(--text2)",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 11,
          cursor: "pointer",
          transition: "background .12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--fill)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {zoomPct}%
      </button>
      <ZoomBtn title="Aumentar zoom" onClick={() => zoomBy(0.2)}>
        +
      </ZoomBtn>
    </div>
  );
}

function ZoomBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 28,
        border: "none",
        borderRadius: 8,
        background: "transparent",
        color: "var(--text2)",
        fontSize: 18,
        lineHeight: 1,
        cursor: "pointer",
        transition: "background .12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--fill)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Canvas hint (bottom-left)
 * ════════════════════════════════════════════════════════════════════════ */
function CanvasHint() {
  const mode = useLoomStore((s) => s.mode);

  const hint =
    mode === "edit"
      ? "arraste das portas para conectar · scroll = zoom · fundo = mover"
      : "arraste os nós · scroll = zoom · ESC limpa seleção";

  return (
    <div
      style={{
        position: "absolute",
        left: 16,
        bottom: 14,
        display: "flex",
        alignItems: "center",
        gap: 7,
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 10,
        color: "var(--muted)",
        background: "var(--glass)",
        padding: "5px 10px",
        borderRadius: 9,
        border: "1px solid var(--glass-border)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <span style={{ opacity: 0.75 }}>{hint}</span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * CanvasOverlay — root export
 * Renders inside the canvas container (position:absolute children).
 * The canvas itself is position:relative; this component renders its
 * children as position:absolute overlays on top of the canvas stage.
 * ════════════════════════════════════════════════════════════════════════ */
export function CanvasOverlay() {
  const mode = useLoomStore((s) => s.mode);
  const adding = useLoomStore((s) => s.adding);

  const showEditControls = mode === "edit";

  return (
    <>
      {/* Add agent button — shown in edit mode when panel is closed */}
      {showEditControls && !adding && <AddButton />}

      {/* Add agent panel — shown in edit mode when open */}
      {showEditControls && adding && <AddAgentPanel />}

      {/* Bottom-left canvas hint */}
      <CanvasHint />

      {/* Bottom-right zoom controls */}
      <ZoomControls />
    </>
  );
}

export default CanvasOverlay;
