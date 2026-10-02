import {
  definePlugin,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "@infinite-canvas/plugin-sdk";
import type {
  CanvasNodeContentProps,
  CanvasNodePanelProps,
  CanvasNodeResourceItem,
  CanvasNodeData,
} from "@infinite-canvas/plugin-sdk";

type Preset = {
  id: string;
  name: string;
  rules: string;
};

type OptimizerMetadata = {
  selectedPresetId?: string;
  optimizedPrompt?: string;
  outputBundle?: CanvasNodeResourceItem[];
  lastRunAt?: number;
  status?: string;
  error?: string;
};

const PRESET_KEY = "presets.v1";
const DEFAULT_PRESETS: Preset[] = [
  {
    id: "general",
    name: "通用提示词优化",
    rules:
      "在忠实保留用户原始意图的前提下，将输入整理成清晰、具体、可执行的生成提示词。充分读取并利用所有参考图片、视频和音频中的视觉、动作、镜头、声音、环境、人物、产品与风格信息。避免无依据新增事实。输出只包含最终优化后的提示词，不要解释过程。",
  },
];

function metadata(ctx: CanvasNodeContentProps["ctx"] | CanvasNodePanelProps["ctx"]): OptimizerMetadata {
  return (ctx.node.metadata || {}) as OptimizerMetadata;
}

function upstreamInConnectionOrder(ctx: CanvasNodeContentProps["ctx"] | CanvasNodePanelProps["ctx"]) {
  const byId = new Map(ctx.getNodes().map((node) => [node.id, node]));
  return ctx
    .getConnections()
    .filter((connection) => connection.toNodeId === ctx.node.id)
    .map((connection) => byId.get(connection.fromNodeId))
    .filter((node): node is CanvasNodeData => Boolean(node));
}

function kindForNode(node: CanvasNodeData): CanvasNodeResourceItem["kind"] | null {
  const type = String(node.type || "").toLowerCase();
  const mime = String(node.metadata?.mimeType || "").toLowerCase();
  if (type === "text" || type.includes(":text")) return "text";
  if (type.includes("video") || mime.startsWith("video/")) return "video";
  if (type.includes("audio") || mime.startsWith("audio/")) return "audio";
  if (
    type.includes("image") ||
    type.includes("mask") ||
    mime.startsWith("image/")
  )
    return "image";
  const content = node.metadata?.content;
  if (typeof content === "string" && content.trim()) return "text";
  return null;
}

function resourceFromNode(node: CanvasNodeData, order: number): CanvasNodeResourceItem | null {
  const kind = kindForNode(node);
  if (!kind) return null;
  const content = typeof node.metadata?.content === "string" ? node.metadata.content : "";
  if (kind === "text")
    return {
      kind,
      text: content,
      sourceNodeId: node.id,
      order,
    };
  if (!content) return null;
  const assetId = typeof node.metadata?.assetId === "string" ? node.metadata.assetId : undefined;
  const projectId = typeof node.metadata?.projectId === "string" ? node.metadata.projectId : undefined;
  return {
    kind,
    url: content,
    ...(assetId ? { assetId } : {}),
    ...(projectId ? { projectId } : {}),
    sourceNodeId: node.id,
    order,
  };
}

function buildInput(ctx: CanvasNodeContentProps["ctx"] | CanvasNodePanelProps["ctx"]) {
  const ordered = upstreamInConnectionOrder(ctx)
    .map((node, index) => resourceFromNode(node, index))
    .filter((item): item is CanvasNodeResourceItem => Boolean(item));
  const texts = ordered.filter((item) => item.kind === "text" && item.text?.trim());
  const media = ordered.filter((item) => item.kind !== "text" && item.url);
  return { ordered, texts, media };
}

function usePresets(ctx: CanvasNodeContentProps["ctx"] | CanvasNodePanelProps["ctx"]) {
  const [presets, setPresets] = useState<Preset[]>(DEFAULT_PRESETS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void ctx.storage.get<Preset[]>(PRESET_KEY).then((stored) => {
      if (!alive) return;
      const next = Array.isArray(stored) && stored.length ? stored : DEFAULT_PRESETS;
      setPresets(next);
      setLoaded(true);
      if (!Array.isArray(stored) || !stored.length) void ctx.storage.set(PRESET_KEY, next);
    });
    return () => {
      alive = false;
    };
  }, [ctx.storage]);

  const save = useCallback(
    async (next: Preset[]) => {
      setPresets(next);
      await ctx.storage.set(PRESET_KEY, next);
    },
    [ctx.storage],
  );

  return { presets, loaded, save };
}

function useOptimizer(ctx: CanvasNodeContentProps["ctx"] | CanvasNodePanelProps["ctx"]) {
  const { presets, loaded, save } = usePresets(ctx);
  const meta = metadata(ctx);
  const selectedId =
    presets.find((preset) => preset.id === meta.selectedPresetId)?.id ||
    presets[0]?.id ||
    "";
  const selected = presets.find((preset) => preset.id === selectedId);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (loaded && selectedId && meta.selectedPresetId !== selectedId)
      ctx.updateMetadata({ selectedPresetId: selectedId });
  }, [ctx, loaded, meta.selectedPresetId, selectedId]);

  const optimize = useCallback(async () => {
    if (!selected || busy) return;
    const { texts, media } = buildInput(ctx);
    if (!texts.length && !media.length) {
      setLocalError("请先连接文本、图片、视频或音频素材。");
      return;
    }

    setBusy(true);
    setLocalError("");
    ctx.updateMetadata({ status: "loading", error: "" });

    const textBlocks = texts.map((item, index) => `文本${index + 1}:\n${item.text}`).join("\n\n");
    const mediaManifest = media
      .map((item, index) => `素材${index + 1}: ${item.kind}，来源节点 ${item.sourceNodeId || "unknown"}`)
      .join("\n");
    const prompt = [
      "请优化以下生成提示词。",
      textBlocks ? `【原始文本】\n${textBlocks}` : "【原始文本】\n无；请根据参考素材生成合适的提示词。",
      mediaManifest ? `【参考素材清单】\n${mediaManifest}\n请实际读取随请求附带的参考素材内容。` : "",
      "严格只输出优化后的最终提示词，不要输出标题、分析、说明、原文复述或 Markdown 代码块。",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const result = await ctx.ai.generateText(prompt, {
        model: ctx.ai.defaultModel("text"),
        system: selected.rules,
        references: media,
      });
      const optimized = String(result.text || "").trim();
      if (!optimized) throw new Error("模型没有返回优化后的提示词");

      // 原文本不输出。非文本素材严格按原连接顺序保留，优化后的提示词最后输出。
      const outputBundle: CanvasNodeResourceItem[] = [
        ...media.map((item, index) => ({ ...item, order: index })),
        {
          kind: "text",
          text: optimized,
          sourceNodeId: ctx.node.id,
          order: media.length,
        },
      ];
      ctx.updateMetadata({
        optimizedPrompt: optimized,
        outputBundle,
        lastRunAt: Date.now(),
        status: "success",
        error: "",
        selectedPresetId: selected.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "提示词优化失败";
      setLocalError(message);
      ctx.updateMetadata({ status: "error", error: message });
    } finally {
      setBusy(false);
    }
  }, [busy, ctx, selected]);

  return {
    presets,
    loaded,
    save,
    selectedId,
    selected,
    busy,
    error: localError || String(meta.error || ""),
    optimize,
  };
}

const buttonStyle = (ctx: CanvasNodeContentProps["ctx"] | CanvasNodePanelProps["ctx"], primary = false) =>
  ({
    border: `1px solid ${primary ? ctx.theme.node.activeStroke : ctx.theme.node.stroke}`,
    background: primary ? ctx.theme.toolbar.activeBg : ctx.theme.toolbar.panel,
    color: primary ? ctx.theme.toolbar.activeText : ctx.theme.node.text,
    borderRadius: 8,
    padding: "7px 10px",
    fontSize: 12,
    cursor: "pointer",
  }) as const;

function Content({ ctx }: CanvasNodeContentProps) {
  const state = useOptimizer(ctx);
  const meta = metadata(ctx);
  const input = buildInput(ctx);
  const mediaCounts = useMemo(
    () => ({
      image: input.media.filter((item) => item.kind === "image").length,
      video: input.media.filter((item) => item.kind === "video").length,
      audio: input.media.filter((item) => item.kind === "audio").length,
      text: input.texts.length,
    }),
    [input.media, input.texts],
  );

  return (
    <div
      data-canvas-no-zoom
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        color: ctx.theme.node.text,
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 12, color: ctx.theme.node.muted }}>
        输入：文本 {mediaCounts.text} · 图片 {mediaCounts.image} · 视频 {mediaCounts.video} · 音频 {mediaCounts.audio}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          value={state.selectedId}
          onChange={(event) => ctx.updateMetadata({ selectedPresetId: event.target.value })}
          style={{
            flex: 1,
            minWidth: 0,
            border: `1px solid ${ctx.theme.node.stroke}`,
            background: ctx.theme.node.panel,
            color: ctx.theme.node.text,
            borderRadius: 8,
            padding: "7px 8px",
            fontSize: 12,
          }}
        >
          {state.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={ctx.openPanel} style={buttonStyle(ctx)}>
          规范
        </button>
      </div>
      <button
        type="button"
        disabled={state.busy || (!input.texts.length && !input.media.length)}
        onClick={() => void state.optimize()}
        style={{
          ...buttonStyle(ctx, true),
          opacity: state.busy ? 0.65 : 1,
        }}
      >
        {state.busy ? "优化中…" : "优化提示词"}
      </button>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          border: `1px solid ${ctx.theme.node.stroke}`,
          background: ctx.theme.node.fill,
          borderRadius: 8,
          padding: 10,
          fontSize: 12,
          lineHeight: 1.55,
        }}
      >
        {meta.optimizedPrompt ? (
          String(meta.optimizedPrompt)
        ) : (
          <span style={{ color: ctx.theme.node.placeholder }}>
            优化结果会显示在这里。输出资源包将保留原图片/视频/音频顺序，并在最后附加优化后的提示词；原文本不会输出。
          </span>
        )}
      </div>
      {state.error ? <div style={{ color: "#ef4444", fontSize: 11 }}>{state.error}</div> : null}
    </div>
  );
}

function Panel({ ctx, onClose }: CanvasNodePanelProps) {
  const state = useOptimizer(ctx);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rules, setRules] = useState("");

  const beginNew = () => {
    setEditingId("__new__");
    setName("");
    setRules("");
  };
  const beginEdit = (preset: Preset) => {
    setEditingId(preset.id);
    setName(preset.name);
    setRules(preset.rules);
  };
  const cancel = () => {
    setEditingId(null);
    setName("");
    setRules("");
  };
  const commit = async () => {
    const cleanName = name.trim();
    const cleanRules = rules.trim();
    if (!cleanName || !cleanRules) return;
    if (editingId === "__new__") {
      const preset: Preset = {
        id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: cleanName,
        rules: cleanRules,
      };
      await state.save([...state.presets, preset]);
      ctx.updateMetadata({ selectedPresetId: preset.id });
    } else if (editingId) {
      await state.save(
        state.presets.map((preset) =>
          preset.id === editingId ? { ...preset, name: cleanName, rules: cleanRules } : preset,
        ),
      );
    }
    cancel();
  };
  const remove = async (preset: Preset) => {
    if (state.presets.length <= 1) return;
    const next = state.presets.filter((item) => item.id !== preset.id);
    await state.save(next);
    if (state.selectedId === preset.id)
      ctx.updateMetadata({ selectedPresetId: next[0]?.id || "" });
    if (editingId === preset.id) cancel();
  };

  return (
    <div
      data-canvas-no-zoom
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      style={{
        width: 560,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        color: ctx.theme.node.text,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 1 }}>提示词规范预设</strong>
        <button type="button" onClick={beginNew} style={buttonStyle(ctx, true)}>
          新增
        </button>
        <button type="button" onClick={onClose} style={buttonStyle(ctx)}>
          关闭
        </button>
      </div>

      <div style={{ maxHeight: 220, overflow: "auto", display: "grid", gap: 7 }}>
        {state.presets.map((preset) => (
          <div
            key={preset.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 6,
              alignItems: "center",
              border: `1px solid ${state.selectedId === preset.id ? ctx.theme.node.activeStroke : ctx.theme.node.stroke}`,
              borderRadius: 8,
              padding: 8,
              background: ctx.theme.node.fill,
            }}
          >
            <button
              type="button"
              onClick={() => ctx.updateMetadata({ selectedPresetId: preset.id })}
              style={{
                border: "none",
                background: "transparent",
                color: ctx.theme.node.text,
                textAlign: "left",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{preset.name}</div>
              <div
                style={{
                  marginTop: 3,
                  fontSize: 10,
                  color: ctx.theme.node.muted,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {preset.rules}
              </div>
            </button>
            <button type="button" onClick={() => beginEdit(preset)} style={buttonStyle(ctx)}>
              编辑
            </button>
            <button
              type="button"
              disabled={state.presets.length <= 1}
              onClick={() => void remove(preset)}
              style={{ ...buttonStyle(ctx), color: "#ef4444" }}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {editingId ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            paddingTop: 10,
            borderTop: `1px solid ${ctx.theme.node.stroke}`,
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="规范名称"
            style={{
              border: `1px solid ${ctx.theme.node.stroke}`,
              background: ctx.theme.node.fill,
              color: ctx.theme.node.text,
              borderRadius: 8,
              padding: 9,
            }}
          />
          <textarea
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            placeholder="填写提示词优化规范。模型会读取所有已连接文本/图片/视频/音频，并严格按此规范优化。"
            style={{
              minHeight: 150,
              resize: "vertical",
              border: `1px solid ${ctx.theme.node.stroke}`,
              background: ctx.theme.node.fill,
              color: ctx.theme.node.text,
              borderRadius: 8,
              padding: 9,
              lineHeight: 1.5,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={cancel} style={buttonStyle(ctx)}>
              取消
            </button>
            <button
              type="button"
              disabled={!name.trim() || !rules.trim()}
              onClick={() => void commit()}
              style={buttonStyle(ctx, true)}
            >
              保存
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default definePlugin({
  id: "prompt-optimizer",
  name: "提示词优化器",
  version: "1.0.0",
  description:
    "读取上游文本/图片/音频/视频，按可管理的提示词规范优化文本，并通过单条连线输出有序素材资源包。",
  nodes: [
    {
      type: "prompt-optimizer:optimizer",
      title: "提示词优化器",
      icon: "✨",
      description: "多模态读取 + 提示词规范预设 + 有序资源包输出",
      defaultSize: { width: 390, height: 330 },
      defaultMetadata: {
        optimizedPrompt: "",
        outputBundle: [],
        status: "idle",
      },
      minimapColor: "#8b5cf6",
      autoOpenPanel: false,
      hasSourceHandle: true,
      resource: (node) => {
        const raw = node.metadata?.outputBundle;
        if (!Array.isArray(raw)) return null;
        const items = raw
          .filter(
            (item): item is CanvasNodeResourceItem =>
              Boolean(item) &&
              typeof item === "object" &&
              ["text", "image", "video", "audio"].includes(String((item as { kind?: unknown }).kind)),
          )
          .map((item, index) => ({ ...item, order: index }));
        return items.length ? { kind: "bundle", items } : null;
      },
      Content,
      Panel,
      toolbar: (ctx) => [
        {
          id: "presets",
          title: "管理提示词规范预设",
          label: "规范预设",
          icon: "⚙",
          onClick: ctx.openPanel,
        },
      ],
    },
  ],
});
