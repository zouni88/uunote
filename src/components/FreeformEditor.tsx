import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { FreeformBlock, FreeformScene, FreeformTable } from "../types";

interface FreeformEditorProps {
  /** 场景 JSON（为空表示空白画布） */
  sceneJson: string;
  /** 画布内容变更（由父组件负责防抖保存） */
  onSceneChange: (json: string) => void;
  /** 同步记录最新场景 JSON 的 ref，父组件保存时可拿到最实时内容 */
  latestJsonRef: MutableRefObject<string>;
}

/** 画布逻辑尺寸（固定大画布，超出可滚动） */
const PAGE_W = 2400;
const PAGE_H = 1600;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const DEFAULT_TEXT_WIDTH = 120;
const DEFAULT_COL_WIDTH = 120;
const DEFAULT_FONT_SIZE = 16;
/** 未显式指定颜色时的文字默认色（跟随主题，深色画布下自动变浅） */
const DEFAULT_COLOR = "var(--text)";

/** 右键菜单可选的文字字号 / 颜色 */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32];
const TEXT_COLORS = [
  "#1f2937", "#6b7280", "#b91c1c", "#ea580c",
  "#ca8a04", "#16a34a", "#2563eb", "#7c3aed",
];

/** 画笔可选的墨色 / 粗细（OneNote 式手写选项；末位浅灰墨供深色画布使用） */
const DRAW_COLORS = ["#1e293b", "#dc2626", "#2563eb", "#16a34a", "#ca8a04", "#9333ea", "#cbd3e1"];
const DRAW_WIDTHS = [1.5, 2.5, 4, 6];

/** 标题级别对应的字号（px） */
const HEADING_SIZES: Record<number, number> = { 1: 28, 2: 22, 3: 18 };
/** 行高档位 */
const LINE_HEIGHTS = [1.2, 1.5, 1.8, 2.2];
/** 文字高亮（底色）可选色 */
const HIGHLIGHT_COLORS = ["#fde047", "#86efac", "#93c5fd", "#f9a8d4", "#fdba74", "#fca5a5"];
/** 单元格底色可选色 */
const CELL_BG_COLORS = ["#eff6ff", "#ecfdf5", "#fefce8", "#fef2f2", "#faf5ff", "#f1f5f9"];
/** 块/表格边框可选色 */
const BORDER_COLORS = ["#cbd5e1", "#94a3b8", "#f87171", "#60a5fa", "#4ade80", "#a78bfa"];

type Mode = "select" | "text" | "draw";

/** 右键菜单状态 */
interface ContextMenuState {
  x: number;
  y: number;
  blockId: string | null;
  /** 表格右键命中的单元格 */
  row: number | null;
  col: number | null;
  /** 文字块内内嵌表格（OneNote 式）的表格 id */
  inlineTableId: string | null;
}

function parseScene(sceneJson: string): FreeformScene {
  if (!sceneJson) return { version: 1, blocks: [] };
  try {
    const data = JSON.parse(sceneJson);
    if (data && typeof data === "object" && Array.isArray(data.blocks)) {
      return { version: 1, blocks: normalizeBlocks(data.blocks) };
    }
  } catch {
    console.error("画布场景 JSON 解析失败", sceneJson.slice(0, 200));
  }
  return { version: 1, blocks: [] };
}

/**
 * 归一化块数据：只修复旧数据里不完整的表格结构（cells/colWidths），
 * 其他块原样透传，避免改动坐标/尺寸改变既有布局与交互行为。
 */
function normalizeBlocks(raw: FreeformBlock[]): FreeformBlock[] {
  return raw.map((b) => {
    if (b.type === "table" && b.table) {
      const cols = b.table.cols && b.table.cols > 0
        ? b.table.cols
        : Math.max(1, b.table.colWidths?.length || 1);
      const rows = b.table.rows && b.table.rows > 0
        ? b.table.rows
        : Math.max(1, b.table.cells?.length || 1);
      const colWidths =
        Array.isArray(b.table.colWidths) && b.table.colWidths.length === cols
          ? b.table.colWidths
          : Array.from({ length: cols }, () => DEFAULT_COL_WIDTH);
      // 重建成 rows×cols 网格，防止旧数据行数不足 / 某行不是数组导致渲染崩溃
      const rawCells = Array.isArray(b.table.cells) ? b.table.cells : [];
      const cells = Array.from({ length: rows }, (_, ri) =>
        Array.from({ length: cols }, (_, ci) => {
          const row = rawCells[ri];
          return Array.isArray(row) ? row[ci] ?? "" : "";
        }),
      );
      return { ...b, table: { ...b.table, cols, rows, colWidths, cells } };
    }
    return b;
  });
}

function ptsToPath(pts: [number, number][]): string {
  if (!Array.isArray(pts)) return "";
  return pts
    .map((p, i) => {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .filter((s): s is string => s !== null)
    .join(" ");
}

function makeTable(rows: number, cols: number, colWidths: number[] = []): FreeformTable {
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  const widths = colWidths.length === cols ? colWidths : Array.from({ length: cols }, () => DEFAULT_COL_WIDTH);
  return { rows, cols, cells, colWidths: widths };
}

/** 表格总宽（各列宽之和，数据缺失时按默认列宽估算） */
function tableTotalWidth(t?: FreeformTable): number {
  if (!t) return 0;
  if (!Array.isArray(t.colWidths) || t.colWidths.length === 0) {
    return (t.cols || 1) * DEFAULT_COL_WIDTH;
  }
  return t.colWidths.reduce((a, b) => a + (Number(b) || DEFAULT_COL_WIDTH), 0);
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** 将块位置限制在画布内（宽高不足时贴边） */
function clampToCanvas(x: number, y: number, w: number, h: number) {
  return {
    x: clamp(Math.round(x), 0, Math.max(0, PAGE_W - w)),
    y: clamp(Math.round(y), 0, Math.max(0, PAGE_H - h)),
  };
}

export default function FreeformEditor({
  sceneJson,
  onSceneChange,
  latestJsonRef,
}: FreeformEditorProps) {
  const [blocks, setBlocks] = useState<FreeformBlock[]>(
    () => parseScene(sceneJson).blocks,
  );
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<Mode>("text");
  /** 主选中块（右键菜单 / 删除按钮 / 缩放手柄作用对象） */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 多选：框选 / Ctrl 点选后选中的全部块 */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 框选进行中的矩形（画布逻辑坐标） */
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** 涂鸦进行中的笔迹（页面坐标，未归一化） */
  const [activeStroke, setActiveStroke] = useState<{
    points: [number, number][];
    color: string;
    width: number;
  } | null>(null);
  /** 画笔当前墨色 / 粗细（默认墨色跟随主题：深色画布下用浅色墨，否则看不见） */
  const [drawColor, setDrawColor] = useState(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--ink-dot").trim() ||
      DRAW_COLORS[0],
  );
  const [drawWidth, setDrawWidth] = useState(DRAW_WIDTHS[1]);
  /** 撤销/重做快照栈（存"操作前"的 blocks），连续高频操作自动合并为一步 */
  const undoStackRef = useRef<FreeformBlock[][]>([]);
  const redoStackRef = useRef<FreeformBlock[][]>([]);
  const lastPushRef = useRef<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  /** 块级内部剪贴板（复制/粘贴块） */
  const clipboardRef = useRef<FreeformBlock[] | null>(null);
  /** 撤销/重做后递增，强制重建 contentEditable 块以同步数据 */
  const [ver, setVer] = useState(0);
  /** 文字选区浮动格式工具条 */
  const [formatBar, setFormatBar] = useState<{
    x: number;
    y: number;
    blockId: string;
    inCell: boolean;
  } | null>(null);

  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  /** 新文字块创建后需要聚焦的 id */
  const focusIdRef = useRef<string | null>(null);
  /** 新表格创建后需要聚焦首格的块 id（OneNote 式：插入即可直接输入） */
  const focusTableFirstCellRef = useRef<string | null>(null);
  /** 本次点击刚创建的文字块 id：其 mousedown 默认聚焦行为会立即触发一次 blur，
   *  用该标记跳过对"创建中的块"的误删，pointerup 后清除 */
  const lastCreatedRef = useRef<string | null>(null);
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  /** 组拖动：本次拖动的所有块 id */
  const dragGroupRef = useRef<Set<string> | null>(null);
  /** 组拖动开始时各块的原始坐标 */
  const dragOriginsRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const resizeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);
  /** 表格列宽拖动 */
  const colResizeRef = useRef<{
    blockId: string;
    col: number;
    startClientX: number;
    origWidths: number[];
  } | null>(null);
  const marqueeRef = useRef<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  /** 画布上最近一次点击的位置（逻辑坐标），用于"点哪粘哪" */
  const lastClickRef = useRef<{ x: number; y: number } | null>(null);
  /** 右键菜单元素，点击菜单内部时不下发关闭 */
  const menuRef = useRef<HTMLDivElement>(null);

  /** 单选一个块并作为主选中 */
  const selectSingle = useCallback((id: string) => {
    setSelectedIds([id]);
    setSelectedId(id);
  }, []);

  const emit = useCallback(
    (next: FreeformBlock[]) => {
      const json = JSON.stringify({ version: 1, blocks: next });
      latestJsonRef.current = json;
      onSceneChange(json);
    },
    [onSceneChange, latestJsonRef],
  );

  /** 直接应用 blocks 并通知保存（不记录历史，供撤销/重做内部使用） */
  const applyBlocksRaw = useCallback(
    (next: FreeformBlock[]) => {
      // 同步更新 ref，避免同一事件内（如 blur 与 pointerdown 先后触发）连续操作读到旧值
      blocksRef.current = next;
      setBlocks(next);
      emit(next);
    },
    [emit],
  );

  /** 压入撤销栈：距上次操作 <600ms 视为同一操作合并（输入/拖动/缩放等高频调用不膨胀历史） */
  const pushUndo = useCallback(() => {
    const now = Date.now();
    if (lastPushRef.current === null || now - lastPushRef.current >= 600) {
      undoStackRef.current.push(blocksRef.current);
      if (undoStackRef.current.length > 100) undoStackRef.current.shift();
      lastPushRef.current = now;
    }
    redoStackRef.current = [];
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(false);
  }, []);

  const applyBlocks = useCallback(
    (next: FreeformBlock[]) => {
      pushUndo();
      applyBlocksRaw(next);
    },
    [pushUndo, applyBlocksRaw],
  );

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const prev = undoStackRef.current.pop()!;
    redoStackRef.current.push(blocksRef.current);
    lastPushRef.current = null;
    setEditingId(null);
    setVer((v) => v + 1);
    applyBlocksRaw(prev);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, [applyBlocksRaw]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(blocksRef.current);
    lastPushRef.current = null;
    setEditingId(null);
    setVer((v) => v + 1);
    applyBlocksRaw(next);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [applyBlocksRaw]);

  /** 客户端坐标 → 画布逻辑坐标（未缩放） */
  const toPage = useCallback(
    (clientX: number, clientY: number) => {
      const rect = pageRef.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / zoom,
        y: (clientY - rect.top) / zoom,
      };
    },
    [zoom],
  );

  const newId = () =>
    `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // ---------- 移动 / 缩放（window 级监听，带防误触阈值） ----------

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragRef.current) {
        const d = dragRef.current;
        const start = toPage(d.startX, d.startY);
        const cur = toPage(e.clientX, e.clientY);
        const dx = cur.x - start.x;
        const dy = cur.y - start.y;
        if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        d.moved = true;
        const origins = dragOriginsRef.current;
        const next = blocksRef.current.map((b) => {
          if (!origins || !origins.has(b.id)) return b;
          const o = origins.get(b.id)!;
          const w = b.type === "table" && b.table ? tableTotalWidth(b.table) : b.width;
          // 用渲染后的实际高度限制纵向范围，避免内容被拖出画布
          const el = document.querySelector(`[data-block-id="${b.id}"]`) as HTMLElement | null;
          const h = el ? Math.max(40, Math.round(el.offsetHeight)) : b.height || 40;
          const pos = clampToCanvas(o.x + dx, o.y + dy, w, h);
          return { ...b, x: pos.x, y: pos.y };
        });
        applyBlocks(next);
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        const start = toPage(r.startX, r.startY);
        const cur = toPage(e.clientX, e.clientY);
        const dx = cur.x - start.x;
        const next = blocksRef.current.map((b) => {
          if (b.id !== r.id) return b;
          // 放大时不允许把块拉出画布右边界
          const maxW = Math.max(80, PAGE_W - b.x);
          const nw = Math.max(80, Math.min(maxW, Math.round(r.origW + dx)));
          const scale = nw / r.origW;
          return { ...b, width: nw, height: Math.max(30, Math.round(r.origH * scale)) };
        });
        applyBlocks(next);
      }
      if (colResizeRef.current) {
        const c = colResizeRef.current;
        const delta = (e.clientX - c.startClientX) / zoom;
        const widths = [...c.origWidths];
        widths[c.col] = Math.max(40, Math.round(c.origWidths[c.col] + delta));
        applyBlocks(
          blocksRef.current.map((b) =>
            b.id === c.blockId && b.table
              ? { ...b, table: { ...b.table, colWidths: widths } }
              : b,
          ),
        );
      }
    };
    const onUp = () => {
      // 本次点击结束，刚创建块的标记失效：之后它再失焦即为真正放弃，可正常移除空框
      lastCreatedRef.current = null;
      dragRef.current = null;
      dragGroupRef.current = null;
      dragOriginsRef.current = null;
      resizeRef.current = null;
      colResizeRef.current = null;
      marqueeRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [zoom, toPage, applyBlocks]);

  // ---------- 画布空白处点击 ----------

  const handlePagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 新一轮点击开始：此前创建块的标记失效（防止保护到已放弃的空框）
    lastCreatedRef.current = null;
    const { x, y } = toPage(e.clientX, e.clientY);
    // 记住点击位置，供粘贴截图"点哪粘哪"使用
    lastClickRef.current = { x, y };
    setFormatBar(null);
    // 空白处点击时清掉文本选区，避免残留光标把粘贴带进旧文字块（文字模式会新建块并重新聚焦）
    if (mode !== "text") window.getSelection()?.removeAllRanges();
    if (mode === "text") {
      addTextBlockAt(x, y);
    } else if (mode === "draw") {
      // 捕获指针，拖出画布仍能继续收集笔迹
      e.currentTarget.setPointerCapture(e.pointerId);
      setActiveStroke({
        points: [[x, y]],
        color: drawColor,
        width: drawWidth,
      });
    } else {
      // 选择模式：从空白处拖出框选矩形
      e.currentTarget.setPointerCapture(e.pointerId);
      marqueeRef.current = { x0: x, y0: y, x1: x, y1: y };
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
      setSelectedIds([]);
      setSelectedId(null);
    }
  };

  const handlePagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = toPage(e.clientX, e.clientY);
    if (activeStroke) {
      setActiveStroke((s) =>
        s ? { ...s, points: [...s.points, [x, y]] } : s,
      );
    }
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      marqueeRef.current = { ...m, x1: x, y1: y };
      setMarquee({ x0: m.x0, y0: m.y0, x1: x, y1: y });
    }
  };

  const handlePagePointerUp = () => {
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      const minX = Math.min(m.x0, m.x1);
      const minY = Math.min(m.y0, m.y1);
      const maxX = Math.max(m.x0, m.x1);
      const maxY = Math.max(m.y0, m.y1);
      const hits = blocksRef.current.filter((b) => {
        const w = b.type === "table" && b.table ? tableTotalWidth(b.table) : b.width;
        const h = b.height || 40;
        return b.x < maxX && b.x + w > minX && b.y < maxY && b.y + h > minY;
      });
      if (hits.length > 0) {
        setSelectedIds(hits.map((b) => b.id));
        setSelectedId(hits[hits.length - 1].id);
      }
      return;
    }
    if (!activeStroke) return;
    const stroke = activeStroke;
    setActiveStroke(null);
    if (stroke.points.length < 2) return;
    const xs = stroke.points.map((p) => p[0]);
    const ys = stroke.points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const block: FreeformBlock = {
      id: newId(),
      type: "drawing",
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
      paths: [
        {
          ...stroke,
          points: stroke.points.map((p) => [p[0] - minX, p[1] - minY]),
        },
      ],
    };
    applyBlocks([...blocksRef.current, block]);
    selectSingle(block.id);
  };

  // ---------- 右键菜单 ----------

  const handlePageContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setFormatBar(null);
    // 右键视为放弃刚创建的空框
    lastCreatedRef.current = null;
    setSelectedIds([]);
    setSelectedId(null);
    setContextMenu({ x: e.clientX, y: e.clientY, blockId: null, row: null, col: null, inlineTableId: null });
  };

  const handleBlockContextMenu = (
    e: React.MouseEvent<HTMLDivElement>,
    block: FreeformBlock,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setFormatBar(null);
    // 右键视为放弃刚创建的空框
    lastCreatedRef.current = null;
    // 右键命中的块不在当前多选中时，单独选中它
    if (!selectedIds.includes(block.id)) selectSingle(block.id);
    setSelectedId(block.id);
    // 表格/文字块内内嵌表格：找出右键命中的单元格
    let row: number | null = null;
    let col: number | null = null;
    let inlineTableId: string | null = null;
    if (block.type === "table" || block.type === "text") {
      const cellEl = (e.target as HTMLElement).closest("[data-cell]") as HTMLElement | null;
      if (cellEl) {
        row = Number(cellEl.dataset.row);
        col = Number(cellEl.dataset.col);
        inlineTableId = block.type === "text"
          ? ((cellEl.closest("table[data-it]") as HTMLElement | null)?.dataset.it ?? null)
          : null;
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY, blockId: block.id, row, col, inlineTableId });
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // 只在点击菜单外部时关闭，否则菜单项自身的 click 永远触发不了
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      close();
    };
    // 延迟挂载，避免本次右键触发立即关闭
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // ---------- 块交互 ----------

  const startDrag = (
    e: React.PointerEvent,
    block: FreeformBlock,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    // 命中的块已在多选中则整组一起拖，否则单独拖它
    const inGroup = selectedIds.includes(block.id) && selectedIds.length > 1;
    if (!inGroup) selectSingle(block.id);
    setSelectedId(block.id);
    const group = inGroup ? new Set(selectedIds) : new Set([block.id]);
    dragGroupRef.current = group;
    const origins = new Map<string, { x: number; y: number }>();
    blocksRef.current.forEach((b) => {
      if (group.has(b.id)) origins.set(b.id, { x: b.x, y: b.y });
    });
    dragOriginsRef.current = origins;
    dragRef.current = {
      id: block.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: block.x,
      origY: block.y,
      moved: false,
    };
  };

  const startResize = (
    e: React.PointerEvent,
    block: FreeformBlock,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    selectSingle(block.id);
    resizeRef.current = {
      id: block.id,
      startX: e.clientX,
      startY: e.clientY,
      origW: block.width,
      origH: block.height,
    };
  };

  /** 拖动表格列右边框调整该列宽度 */
  const startColResize = (
    e: React.PointerEvent,
    block: FreeformBlock,
    col: number,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!block.table) return;
    selectSingle(block.id);
    colResizeRef.current = {
      blockId: block.id,
      col,
      startClientX: e.clientX,
      origWidths: [...block.table.colWidths],
    };
  };

  const handleBlockDown = (
    e: React.PointerEvent<HTMLDivElement>,
    block: FreeformBlock,
  ) => {
    if (e.button !== 0) return;
    // 点击块即放弃此前刚创建的空框，标记失效
    lastCreatedRef.current = null;
    e.stopPropagation();
    // Ctrl/Cmd 点选：切换块的选中状态（用于多选）
    if (e.ctrlKey || e.metaKey) {
      const has = selectedIds.includes(block.id);
      const next = has
        ? selectedIds.filter((i) => i !== block.id)
        : [...selectedIds, block.id];
      setSelectedIds(next);
      setSelectedId(block.id);
      return;
    }
    // 锁定块：可选中、可删除，但不可拖动/编辑（编辑由 contentEditable=false 兜底）
    if (block.locked) {
      if (!selectedIds.includes(block.id)) selectSingle(block.id);
      setSelectedId(block.id);
      return;
    }
    if (!selectedIds.includes(block.id)) selectSingle(block.id);
    setSelectedId(block.id);
    // 文字块/表格：选择模式下可按住正文整体拖动（带阈值防误触），
    // 文字/编辑模式下点击正文用于编辑
    if (block.type === "text" || block.type === "table") {
      if (mode === "select") startDrag(e, block);
      return;
    }
    startDrag(e, block);
  };

  /** 读取文字块 innerHTML 并同步数据、按内容自动加宽（支持块内内嵌图片） */
  const updateTextBlockFromEl = (blockId: string, el: HTMLElement) => {
    const html = el.innerHTML;
    // 模拟 OneNote：文本容器随内容自动加宽/收缩（不超过画布右边界）。
    // 用 max-content 测量内容实际宽度，避免 scrollWidth 不小于容器宽导致无法收缩
    const prevWS = el.style.whiteSpace;
    const prevW = el.style.width;
    el.style.whiteSpace = "nowrap";
    el.style.width = "max-content";
    const naturalW = el.offsetWidth;
    el.style.whiteSpace = prevWS;
    el.style.width = prevW;
    const b = blocksRef.current.find((x) => x.id === blockId);
    const maxW = Math.max(80, PAGE_W - (b?.x ?? 0));
    // 留一点余量，避免最后一个字符恰好换行
    const width = Math.round(clamp(naturalW + 12, 80, maxW));
    applyBlocks(
      blocksRef.current.map((bl) =>
        bl.id === blockId ? { ...bl, text: html, width } : bl,
      ),
    );
  };

  const handleTextInput = (
    blockId: string,
    e: React.FormEvent<HTMLDivElement>,
  ) => {
    updateTextBlockFromEl(blockId, e.currentTarget);
  };

  /** 文字块失焦：内容为空（无文字/图片/内嵌表格）的块自动移除，避免留下无内容的编辑框。
   *  点击画布新建的块，其 mousedown 默认聚焦行为会紧接触发一次 blur（此时块刚被聚焦，
   *  还没机会输入），需用 lastCreatedRef 跳过，等真正失焦（用户点击别处）再移除。 */
  const handleTextBlur = (blockId: string) => {
    setEditingId((prev) => (prev === blockId ? null : prev));
    // 刚创建的文字块：跳过本次 blur 造成的移除，pointerup 后标记清除、下次失焦正常处理
    if (lastCreatedRef.current === blockId) return;
    const el = document.querySelector(
      `[data-block-id="${blockId}"] .ff-text-editable`,
    ) as HTMLElement | null;
    if (!el) return; // 已被删除/卸载
    // 含图片或内嵌表格视为有内容；仅空白（<br>、空格、nbsp 等）视为空
    if (el.querySelector("table, img")) return;
    if ((el.textContent ?? "").replace(/\s/g, "")) return;
    const next = blocksRef.current.filter((b) => b.id !== blockId);
    if (next.length === blocksRef.current.length) return;
    applyBlocks(next);
    setSelectedIds((prev) => prev.filter((id) => id !== blockId));
    setSelectedId((prev) => (prev === blockId ? null : prev));
  };

  const handleCellInput = (
    blockId: string,
    row: number,
    col: number,
    e: React.FormEvent<HTMLDivElement>,
  ) => {
    const html = e.currentTarget.innerHTML;
    applyBlocks(
      blocksRef.current.map((b) => {
        if (b.id !== blockId || !b.table) return b;
        const cells = b.table.cells.map((r, ri) =>
          ri === row ? r.map((cell, ci) => (ci === col ? html : cell)) : r,
        );
        return { ...b, table: { ...b.table, cells } };
      }),
    );
  };

  const deleteBlocks = (ids: string[]) => {
    const set = new Set(ids);
    applyBlocks(blocksRef.current.filter((b) => !set.has(b.id)));
    setSelectedIds([]);
    setSelectedId(null);
    setEditingId(null);
    setContextMenu(null);
  };

  // ---------- 块级复制 / 粘贴 / 复制副本 ----------

  /** 复制当前选中块（深拷贝进内部剪贴板） */
  const copyBlocks = () => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
    if (!ids.length) return;
    const set = new Set(ids);
    clipboardRef.current = blocksRef.current
      .filter((b) => set.has(b.id))
      .map((b) => JSON.parse(JSON.stringify(b)) as FreeformBlock);
  };

  /** 粘贴内部剪贴板中的块到指定画布位置（默认上次点击处/视口中心） */
  const pasteBlocks = (at?: { x: number; y: number }) => {
    if (!clipboardRef.current?.length) return;
    const pos = at ?? lastClickRef.current ?? centerOfView();
    // 单块粘贴向右下偏移，避免与原块完全重叠
    const dx = clipboardRef.current.length === 1 ? 24 : 0;
    const copies: FreeformBlock[] = clipboardRef.current.map((b) => {
      const w = b.type === "table" && b.table ? tableTotalWidth(b.table) : b.width;
      const p = clampToCanvas(pos.x + dx, pos.y + 24, w, b.height || 40);
      return { ...b, id: newId(), x: p.x, y: p.y };
    });
    applyBlocks([...blocksRef.current, ...copies]);
    selectSingle(copies[0].id);
  };

  /** 复制副本（Ctrl+D）：复制一份选中块贴在原内容右下角 */
  const duplicateBlocks = () => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
    if (!ids.length) return;
    const set = new Set(ids);
    const sel = blocksRef.current.filter((b) => set.has(b.id));
    if (!sel.length) return;
    const minX = Math.min(...sel.map((b) => b.x));
    const minY = Math.min(...sel.map((b) => b.y));
    copyBlocks();
    pasteBlocks({ x: minX, y: minY });
  };

  /** 修改文字块样式（字号/颜色/标题/行高/背景/边框） */
  const setTextStyle = (
    id: string,
    patch: Partial<
      Pick<
        FreeformBlock,
        "fontSize" | "color" | "heading" | "lineHeight" | "bgColor" | "borderColor"
      >
    >,
  ) => {
    applyBlocks(
      blocksRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
    setContextMenu(null);
  };

  // ---------- 批量对齐 / 分布 ----------

  type AlignMode =
    | "left"
    | "hcenter"
    | "right"
    | "top"
    | "vcenter"
    | "bottom"
    | "hdist"
    | "vdist";

  /** 对选中块执行对齐 / 均分（基于选中集包围盒） */
  const alignBlocks = (mode: AlignMode) => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
    if (ids.length < 2) return;
    const set = new Set(ids);
    const sel = blocksRef.current.filter((b) => set.has(b.id));
    if (sel.length < 2) return;
    const box = sel.map((b) => {
      const w = b.type === "table" && b.table ? tableTotalWidth(b.table) : b.width;
      const el = document.querySelector(
        `[data-block-id="${b.id}"]`,
      ) as HTMLElement | null;
      const h = el ? Math.max(24, Math.round(el.offsetHeight)) : (b.height || 40);
      return { b, w, h };
    });
    const minX = Math.min(...box.map((o) => o.b.x));
    const maxX = Math.max(...box.map((o) => o.b.x + o.w));
    const minY = Math.min(...box.map((o) => o.b.y));
    const maxY = Math.max(...box.map((o) => o.b.y + o.h));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // 均分：按坐标排序，把空隙平均分配到相邻块之间（至少 3 块且总宽/高小于包围盒才有效）
    if (mode === "hdist" || mode === "vdist") {
      const total = box.reduce((s, o) => s + (mode === "hdist" ? o.w : o.h), 0);
      const span = mode === "hdist" ? maxX - minX : maxY - minY;
      if (box.length < 3 || span <= total) return;
      const sorted = [...box].sort((a, b) =>
        mode === "hdist" ? a.b.x - b.b.x : a.b.y - b.b.y,
      );
      const gap = (span - total) / (box.length - 1);
      const pos = new Map<string, number>();
      let cur = 0;
      sorted.forEach((o) => {
        pos.set(o.b.id, cur);
        cur += (mode === "hdist" ? o.w : o.h) + gap;
      });
      applyBlocks(
        blocksRef.current.map((bb) => {
          if (!set.has(bb.id)) return bb;
          const p = pos.get(bb.id)!;
          return mode === "hdist"
            ? { ...bb, x: Math.round(minX + p) }
            : { ...bb, y: Math.round(minY + p) };
        }),
      );
      return;
    }

    applyBlocks(
      blocksRef.current.map((bb) => {
        if (!set.has(bb.id)) return bb;
        const o = box.find((x) => x.b.id === bb.id)!;
        let x = bb.x;
        let y = bb.y;
        if (mode === "left") x = minX;
        else if (mode === "hcenter") x = cx - o.w / 2;
        else if (mode === "right") x = maxX - o.w;
        else if (mode === "top") y = minY;
        else if (mode === "vcenter") y = cy - o.h / 2;
        else if (mode === "bottom") y = maxY - o.h;
        return { ...bb, x: Math.round(x), y: Math.round(y) };
      }),
    );
  };

  // ---------- 块级工具（锁定 / 层级 / 背景 / 边框） ----------

  /** 通用设置块属性 */
  const setBlockProps = (id: string, patch: Partial<FreeformBlock>) => {
    applyBlocks(
      blocksRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
    setContextMenu(null);
  };

  /** 置于顶层 / 底层（通过 z 层级） */
  const bringToFront = (id: string) => {
    const maxZ = Math.max(0, ...blocksRef.current.map((b) => b.z ?? 0));
    setBlockProps(id, { z: maxZ + 1 });
  };
  const sendToBack = (id: string) => {
    const minZ = Math.min(0, ...blocksRef.current.map((b) => b.z ?? 0));
    setBlockProps(id, { z: minZ - 1 });
  };

  /** 表格：表头行 / 边框色 / 单元格底色 */
  const setHeaderRows = (id: string, n: number) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table) return;
    setTableData(id, { ...b.table, headerRows: n });
    setContextMenu(null);
  };
  const setTableBorderColor = (id: string, color?: string) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table) return;
    setTableData(id, { ...b.table, borderColor: color });
    setContextMenu(null);
  };
  const setCellBgColor = (id: string, row: number, col: number, color?: string) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table) return;
    const t = b.table;
    const base =
      t.cellBg ??
      Array.from({ length: t.rows }, () => Array.from({ length: t.cols }, () => ""));
    const cellBg = base.map((r, ri) => {
      const next = [...r];
      if (ri === row) next[col] = color ?? "";
      return next;
    });
    setTableData(id, { ...t, cellBg });
    setContextMenu(null);
  };

  // ---------- 表格操作 ----------

  const setTableData = (id: string, table: FreeformTable) => {
    applyBlocks(
      blocksRef.current.map((b) => (b.id === id ? { ...b, table } : b)),
    );
  };

  const insertRow = (id: string, at: number, dir: "above" | "below") => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table) return;
    const t = b.table;
    const newRow = Array.from({ length: t.cols }, () => "");
    const cells = [...t.cells];
    const pos = dir === "above" ? at : at + 1;
    cells.splice(pos, 0, newRow);
    // 同步单元格底色矩阵（新行插入后，底色行也跟随插入空行）
    const cellBg = t.cellBg ? [...t.cellBg.map((r) => [...r])] : undefined;
    if (cellBg) cellBg.splice(pos, 0, Array.from({ length: t.cols }, () => ""));
    setTableData(id, { ...t, rows: cells.length, cells, cellBg });
    setContextMenu(null);
  };

  const insertCol = (id: string, at: number, dir: "left" | "right") => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table) return;
    const t = b.table;
    const pos = dir === "left" ? at : at + 1;
    const cells = t.cells.map((row) => {
      const next = [...row];
      next.splice(pos, 0, "");
      return next;
    });
    const colWidths = [...t.colWidths];
    colWidths.splice(pos, 0, DEFAULT_COL_WIDTH);
    const cellBg = t.cellBg
      ? t.cellBg.map((row) => {
          const next = [...row];
          next.splice(pos, 0, "");
          return next;
        })
      : undefined;
    setTableData(id, { ...t, cols: cells[0].length, cells, colWidths, cellBg });
    setContextMenu(null);
  };

  const deleteRow = (id: string, at: number) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table || b.table.rows <= 1) return;
    const t = b.table;
    const cells = t.cells.filter((_, ri) => ri !== at);
    const cellBg = t.cellBg ? t.cellBg.filter((_, ri) => ri !== at) : undefined;
    // 删除表头行时同步 headerRows
    const headerRows =
      t.headerRows && at < t.headerRows ? Math.max(0, t.headerRows - 1) : t.headerRows;
    setTableData(id, { ...t, rows: cells.length, cells, cellBg, headerRows });
    setContextMenu(null);
  };

  const deleteCol = (id: string, at: number) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table || b.table.cols <= 1) return;
    const t = b.table;
    const cells = t.cells.map((row) => row.filter((_, ci) => ci !== at));
    const colWidths = t.colWidths.filter((_, ci) => ci !== at);
    const cellBg = t.cellBg
      ? t.cellBg.map((row) => row.filter((_, ci) => ci !== at))
      : undefined;
    setTableData(id, { ...t, cols: cells[0].length, cells, colWidths, cellBg });
    setContextMenu(null);
  };

  /** 聚焦表格指定单元格，并把光标放到开头（OneNote 式 Tab 跳格） */
  const focusCell = (blockEl: HTMLElement, row: number, col: number) => {
    const cell = blockEl.querySelector(
      `[data-cell][data-row="${row}"][data-col="${col}"]`,
    ) as HTMLElement | null;
    if (!cell) return;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  /** 单元格键盘：Tab 下一个 / Shift+Tab 上一个，最后单元格 Tab 自动新增一行 */
  const handleCellKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    blockId: string,
    row: number,
    col: number,
  ) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const blockEl = (e.currentTarget as HTMLElement).closest(
      "[data-block-id]",
    ) as HTMLElement | null;
    if (!blockEl) return;
    const b = blocksRef.current.find((x) => x.id === blockId);
    if (!b?.table) return;
    const t = b.table;
    if (e.shiftKey) {
      if (col > 0) focusCell(blockEl, row, col - 1);
      else if (row > 0) focusCell(blockEl, row - 1, t.cols - 1);
      return;
    }
    if (col < t.cols - 1) {
      focusCell(blockEl, row, col + 1);
    } else if (row < t.rows - 1) {
      focusCell(blockEl, row + 1, 0);
    } else {
      // 最后一个单元格：新增一行并聚焦新行第一格
      const newRow = Array.from({ length: t.cols }, () => "");
      const cells = [...t.cells, newRow];
      const nextRow = cells.length - 1;
      setTableData(blockId, { ...t, rows: cells.length, cells });
      window.setTimeout(() => focusCell(blockEl, nextRow, 0), 0);
    }
  };

  // ---------- 文字块内内嵌表格（OneNote 式） ----------

  /** 内嵌表格单元格默认列宽 */
  const INLINE_CELL_W = 100;

  /** 生成内嵌表格 HTML（复用 .ff-table / .ff-cell 样式） */
  const makeInlineTableHtml = (rows: number, cols: number, tableId: string) => {
    const width = cols * INLINE_CELL_W;
    let html = `<table class="ff-table ff-inline-table" data-it="${tableId}" style="width:${width}px" cellspacing="0"><tbody>`;
    for (let r = 0; r < rows; r++) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) {
        html += `<td style="width:${INLINE_CELL_W}px;min-width:${INLINE_CELL_W}px">`;
        html += `<div class="ff-cell" contenteditable="true" data-cell="1" data-row="${r}" data-col="${c}"><br></div>`;
        html += "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  };

  /** 聚焦内嵌表格单元格（光标放到开头） */
  const focusInlineCell = (cell: HTMLElement | null) => {
    if (!cell) return;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  /** 重排内嵌表格所有单元格的 data-row/data-col（增删行列后调用） */
  const reindexInlineTable = (table: HTMLTableElement) => {
    table.querySelectorAll("tr").forEach((tr, ri) => {
      Array.from(tr.querySelectorAll("[data-cell]")).forEach((cell, ci) => {
        cell.setAttribute("data-row", String(ri));
        cell.setAttribute("data-col", String(ci));
      });
    });
  };

  /** 在文字块当前光标处插入内嵌表格（表格跟在光标后面，光标进入第一格） */
  const insertInlineTableAtCaret = (textEl: HTMLElement, blockId: string, rows = 2, cols = 2) => {
    const tableId = `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const sel = window.getSelection();
    let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range || !textEl.contains(range.commonAncestorContainer)) {
      const r = document.createRange();
      r.selectNodeContents(textEl);
      r.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(r);
      range = r;
    }
    const holder = document.createElement("div");
    holder.innerHTML = makeInlineTableHtml(rows, cols, tableId);
    const table = holder.firstElementChild as HTMLElement;
    range.deleteContents();
    range.insertNode(table);
    focusInlineCell(
      table.querySelector('[data-cell][data-row="0"][data-col="0"]') as HTMLElement,
    );
    updateTextBlockFromEl(blockId, textEl);
  };

  /** 内嵌表格增删行列（直接操作文字块 DOM 里的 table，再同步块数据） */
  const inlineTableOp = (
    blockId: string,
    tableId: string,
    op: "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "delRow" | "delCol",
    row: number,
    col: number,
  ) => {
    const blockEl = document.querySelector(`[data-block-id="${blockId}"]`);
    const textEl = blockEl?.querySelector(".ff-text-editable") as HTMLElement | null;
    const table = blockEl?.querySelector(`table[data-it="${tableId}"]`) as HTMLTableElement | null;
    if (!textEl || !table) return;
    const trs = Array.from(table.querySelectorAll("tr"));
    const mkTd = (src: HTMLTableCellElement) => {
      const td = document.createElement("td");
      td.style.width = src.style.width;
      td.style.minWidth = src.style.minWidth;
      const cell = document.createElement("div");
      cell.className = "ff-cell";
      cell.setAttribute("contenteditable", "true");
      cell.setAttribute("data-cell", "1");
      cell.innerHTML = "<br>";
      td.appendChild(cell);
      return td;
    };
    switch (op) {
      case "rowAbove":
      case "rowBelow": {
        const tr = trs[row];
        if (!tr) break;
        const newTr = tr.cloneNode(true) as HTMLTableRowElement;
        Array.from(newTr.querySelectorAll("[data-cell]")).forEach((c) => {
          c.innerHTML = "<br>";
        });
        tr.parentNode?.insertBefore(newTr, op === "rowAbove" ? tr : tr.nextSibling);
        break;
      }
      case "colLeft":
      case "colRight": {
        trs.forEach((tr) => {
          const td = tr.cells[col];
          if (!td) return;
          tr.insertBefore(mkTd(td), op === "colLeft" ? td : td.nextSibling);
        });
        break;
      }
      case "delRow": {
        if (trs.length <= 1) break;
        trs[row]?.remove();
        break;
      }
      case "delCol": {
        if (trs.length && trs[0].cells.length <= 1) break;
        trs.forEach((tr) => tr.cells[col]?.remove());
        break;
      }
    }
    reindexInlineTable(table);
    updateTextBlockFromEl(blockId, textEl);
    setContextMenu(null);
  };

  /** 文字块内 Tab 导航：内嵌表格单元格跳格，最后一格 Tab 新增一行 */
  const handleTextBlockKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    blockId: string,
  ) => {
    if (e.key !== "Tab") return;
    const cell = (e.target as HTMLElement).closest?.("[data-cell]") as HTMLElement | null;
    const table = cell?.closest("table[data-it]") as HTMLTableElement | null;
    if (!cell || !table) return;
    e.preventDefault();
    const cells = Array.from(table.querySelectorAll("[data-cell]"));
    const idx = cells.indexOf(cell);
    if (e.shiftKey && idx > 0) {
      focusInlineCell(cells[idx - 1] as HTMLElement);
      return;
    }
    if (!e.shiftKey && idx < cells.length - 1) {
      focusInlineCell(cells[idx + 1] as HTMLElement);
      return;
    }
    if (!e.shiftKey && idx === cells.length - 1) {
      // 最后一格 Tab → 新增一行并聚焦新行第一格
      const lastTr = table.rows[table.rows.length - 1];
      const newTr = lastTr.cloneNode(true) as HTMLTableRowElement;
      Array.from(newTr.querySelectorAll("[data-cell]")).forEach((c) => {
        c.innerHTML = "<br>";
      });
      table.querySelector("tbody")?.appendChild(newTr);
      reindexInlineTable(table);
      const textEl = table.closest(".ff-text-editable") as HTMLElement | null;
      if (textEl) updateTextBlockFromEl(blockId, textEl);
      focusInlineCell(newTr.querySelector("[data-cell]") as HTMLElement);
    }
  };

  /** 插入表格（OneNote 式）：光标在文字块里 → 内嵌插到光标处；否则在点击处放浮动表格块 */
  const insertTableFromCaret = (rows = 2, cols = 2) => {
    const container = getPasteContainer();
    if (container?.type === "text") {
      const blockId = container.el.closest("[data-block-id]")?.getAttribute("data-block-id");
      if (blockId) {
        insertInlineTableAtCaret(container.el, blockId, rows, cols);
        return;
      }
    }
    const pos = lastClickRef.current ?? centerOfView();
    addTableBlockAt(pos.x, pos.y, rows, cols, true);
  };

  /** 右键菜单表格操作：浮动表格块走数据层，文字块内嵌表格走 DOM 层 */
  const handleTableMenuAction = (
    action: "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "delRow" | "delCol",
  ) => {
    if (!contextMenu) return;
    const block = blocksRef.current.find((b) => b.id === contextMenu.blockId);
    if (!block) return;
    const { row, col } = contextMenu;
    if (block.type === "table" && row !== null && col !== null) {
      switch (action) {
        case "rowAbove":
          insertRow(block.id, row, "above");
          return;
        case "rowBelow":
          insertRow(block.id, row, "below");
          return;
        case "colLeft":
          insertCol(block.id, col, "left");
          return;
        case "colRight":
          insertCol(block.id, col, "right");
          return;
        case "delRow":
          deleteRow(block.id, row);
          return;
        case "delCol":
          deleteCol(block.id, col);
          return;
      }
    } else if (
      block.type === "text" &&
      contextMenu.inlineTableId &&
      row !== null &&
      col !== null
    ) {
      inlineTableOp(block.id, contextMenu.inlineTableId, action, row, col);
    }
    setContextMenu(null);
  };

  // ---------- 新建内容 ----------

  const addTextBlockAt = (x: number, y: number) => {
    const block: FreeformBlock = {
      id: newId(),
      type: "text",
      x: Math.round(x),
      y: Math.round(y),
      width: DEFAULT_TEXT_WIDTH,
      height: 40,
      text: "",
    };
    const pos = clampToCanvas(block.x, block.y, block.width, block.height);
    block.x = pos.x;
    block.y = pos.y;
    lastCreatedRef.current = block.id;
    focusIdRef.current = block.id;
    applyBlocks([...blocksRef.current, block]);
    selectSingle(block.id);
  };

  const addTableBlockAt = (
    cx: number,
    cy: number,
    rows = 3,
    cols = 3,
    centered = false,
  ) => {
    const width = cols * DEFAULT_COL_WIDTH;
    // 粗略高度估算（单元格最小高 28 + 上下内边距 8），仅用于居中与边界限制
    const height = Math.max(40, rows * 36);
    const x = centered ? cx - width / 2 : cx;
    const y = centered ? cy - height / 2 : cy;
    const pos = clampToCanvas(x, y, width, height);
    const block: FreeformBlock = {
      id: newId(),
      type: "table",
      x: pos.x,
      y: pos.y,
      width,
      height: 40,
      table: makeTable(rows, cols),
    };
    applyBlocks([...blocksRef.current, block]);
    selectSingle(block.id);
    // 插入表格后光标直接进入第一格，可立即输入
    focusTableFirstCellRef.current = block.id;
  };

  /** 插入内容的基准位置：视口中心对应的画布逻辑坐标。
   *  画布整宽/整高可见时取画布自身中心，否则取视口中心并钳制在画布内，
   *  避免画布小于视口（缩小后）时把内容插到画布角落甚至画布外。 */
  const centerOfView = () => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return { x: 80, y: 80 };
    const fitX = PAGE_W * zoom <= scrollEl.clientWidth;
    const fitY = PAGE_H * zoom <= scrollEl.clientHeight;
    return {
      x: fitX
        ? PAGE_W / 2
        : clamp((scrollEl.scrollLeft + scrollEl.clientWidth / 2) / zoom, 0, PAGE_W),
      y: fitY
        ? PAGE_H / 2
        : clamp((scrollEl.scrollTop + scrollEl.clientHeight / 2) / zoom, 0, PAGE_H),
    };
  };

  const handleMenuInsertText = () => {
    if (!contextMenu) return;
    const { x, y } = toPage(contextMenu.x, contextMenu.y);
    addTextBlockAt(x, y);
    setContextMenu(null);
  };

  const handleMenuInsertTable = () => {
    if (!contextMenu) return;
    const { x, y } = toPage(contextMenu.x, contextMenu.y);
    addTableBlockAt(x, y, 2, 2, true);
    setContextMenu(null);
  };

  const handleDeleteKey = (e: KeyboardEvent) => {
    if ((!selectedId && selectedIds.length === 0) || editingId) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable)
    ) {
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteBlocks(selectedIds.length ? selectedIds : [selectedId!]);
    }
  };

  useEffect(() => {
    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  });

  // 撤销/重做 / 块级复制粘贴 / 复制副本（仅在未编辑文本时拦截，避免与系统文本快捷键冲突）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      const editing =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (editing) return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "d") {
        e.preventDefault();
        duplicateBlocks();
        return;
      }
      if (key === "c" && (selectedId || selectedIds.length > 0)) {
        e.preventDefault();
        copyBlocks();
        return;
      }
      if (key === "v" && clipboardRef.current?.length) {
        e.preventDefault();
        pasteBlocks();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** 新建文字块后聚焦并定位光标到末尾 */
  useEffect(() => {
    if (!focusIdRef.current) return;
    const id = focusIdRef.current;
    focusIdRef.current = null;
    const el = document.querySelector(
      `[data-block-id="${id}"] .ff-text-editable`,
    ) as HTMLElement | null;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [blocks]);

  /** 新建表格后聚焦第一格（OneNote 式：插入表格后可直接开始输入） */
  useEffect(() => {
    if (!focusTableFirstCellRef.current) return;
    const id = focusTableFirstCellRef.current;
    focusTableFirstCellRef.current = null;
    const el = document.querySelector(
      `[data-block-id="${id}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    focusCell(el, 0, 0);
  }, [blocks]);

  // ---------- 缩放 ----------

  const zoomIn = () =>
    setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.1) * 100) / 100));
  const zoomOut = () =>
    setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.1) * 100) / 100));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) =>
        Math.min(
          MAX_ZOOM,
          Math.max(
            MIN_ZOOM,
            Math.round((z - e.deltaY * 0.001) * 100) / 100,
          ),
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---------- 插入图片 ----------

  /** 在指定位置插入图片块（left/top 为图片左上角，画布内自动钳制） */
  const addImageBlockAt = (
    src: string,
    left: number,
    top: number,
    width: number,
    height: number,
  ) => {
    const pos = clampToCanvas(Math.round(left), Math.round(top), width, height);
    const block: FreeformBlock = {
      id: newId(),
      type: "image",
      x: pos.x,
      y: pos.y,
      width,
      height,
      src,
    };
    applyBlocks([...blocksRef.current, block]);
    selectSingle(block.id);
  };

  /** 从文件读取并插入到视口中心（文件选择按钮） */
  const insertImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      const src = reader.result;
      const img = new Image();
      img.onload = () => {
        const { x: cx, y: cy } = centerOfView();
        const width = Math.min(480, img.naturalWidth);
        const height = Math.max(40, Math.round((img.naturalHeight * width) / img.naturalWidth));
        addImageBlockAt(src, cx - width / 2, cy - height / 2, width, height);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  // ---------- 粘贴截图（OneNote 式：光标在哪就贴到哪） ----------

  /** 光标当前所在的可编辑容器（文字块/表格单元格），不在其中返回 null */
  const getPasteContainer = (): { el: HTMLElement; type: "text" | "cell" } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.focusNode) return null;
    const node = sel.focusNode;
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as HTMLElement)
        : ((node.parentElement as HTMLElement | null) ?? null);
    if (!el) return null;
    const textEl = el.closest(".ff-text-editable");
    if (textEl) return { el: textEl as HTMLElement, type: "text" };
    const cellEl = el.closest(".ff-cell");
    if (cellEl) return { el: cellEl as HTMLElement, type: "cell" };
    return null;
  };

  /** 把图片内联插入到可编辑容器当前光标处，并同步块数据 */
  const insertInlineImage = (
    container: { el: HTMLElement; type: "text" | "cell" },
    src: string,
    displayW: number,
  ) => {
    const { el, type } = container;
    const sel = window.getSelection();
    let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(r);
      range = r;
    }
    const img = document.createElement("img");
    img.src = src;
    img.style.maxWidth = `${displayW}px`;
    img.style.maxHeight = "400px";
    img.style.verticalAlign = "middle";
    img.alt = "";
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    const blockId = (el.closest("[data-block-id]") as HTMLElement | null)?.dataset.blockId;
    if (!blockId) return;
    if (type === "text") {
      updateTextBlockFromEl(blockId, el);
    } else {
      // 单元格：更新内容并适当加宽该列，避免图片溢出
      const row = Number(el.dataset.row);
      const col = Number(el.dataset.col);
      applyBlocks(
        blocksRef.current.map((b) => {
          if (b.id !== blockId || !b.table) return b;
          const cells = b.table.cells.map((r, ri) =>
            ri === row ? r.map((c, ci) => (ci === col ? el.innerHTML : c)) : r,
          );
          const colWidths = b.table.colWidths.map((w, ci) =>
            ci === col ? Math.max(w, displayW) : w,
          );
          return { ...b, table: { ...b.table, cells, colWidths } };
        }),
      );
    }
  };

  /** 粘贴图片：光标在文字块/单元格 → 内联插入；否则 → 插到上次点击的画布位置 */
  const pasteImage = (src: string, displayW: number, displayH: number) => {
    const container = getPasteContainer();
    if (container) {
      if (container.type === "text") {
        const blockId = container.el.closest("[data-block-id]")?.getAttribute("data-block-id");
        const block = blockId ? blocksRef.current.find((b) => b.id === blockId) : null;
        // 空白文字块（点击画布自动创建的）→ 直接替换成图片块，更接近 OneNote
        if (block && !(block.text ?? "").trim()) {
          const id = newId();
          applyBlocks(
            blocksRef.current
              .filter((b) => b.id !== block.id)
              .concat({
                id,
                type: "image",
                x: block.x,
                y: block.y,
                width: displayW,
                height: displayH,
                src,
              }),
          );
          selectSingle(id);
          return;
        }
      }
      insertInlineImage(container, src, displayW);
      return;
    }
    // 画布空白处粘贴：插到上次点击的位置（没有则视口中心）
    const pos = lastClickRef.current ?? centerOfView();
    addImageBlockAt(src, pos.x - displayW / 2, pos.y - displayH / 2, displayW, displayH);
  };
  /** 始终指向最新版 pasteImage，供一次性挂载的粘贴监听使用（避免读到旧状态） */
  const pasteImageRef = useRef(pasteImage);
  pasteImageRef.current = pasteImage;

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      // 仅在剪贴板含图片时拦截，文字粘贴等交给默认行为（不影响文本编辑）
      let imageFile: File | null = null;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          imageFile = item.getAsFile();
          break;
        }
      }
      if (!imageFile) return;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") return;
        const src = reader.result;
        const img = new Image();
        img.onload = () => {
          const displayW = Math.min(480, img.naturalWidth);
          const displayH = Math.max(40, Math.round((img.naturalHeight * displayW) / img.naturalWidth));
          pasteImageRef.current(src, displayW, displayH);
        };
        img.src = src;
      };
      reader.readAsDataURL(imageFile);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // ---------- 文字选区浮动格式工具条（Notion 式） ----------

  /** 执行选区级格式命令并同步块数据（加粗/斜体/下划线/高亮/颜色/列表/清除格式） */
  const runFormat = (cmd: string, value?: string) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const node = sel.focusNode;
    const el = (
      node && node.nodeType === 1
        ? (node as HTMLElement)
        : ((node?.parentElement as HTMLElement) ?? null)
    ) as HTMLElement | null;
    const editable = el?.closest?.(".ff-text-editable, .ff-cell") as HTMLElement | null;
    document.execCommand(cmd, false, value);
    if (!editable) return;
    const blockId = editable.closest("[data-block-id]")?.getAttribute("data-block-id");
    if (!blockId) return;
    const cellEl = editable.classList.contains("ff-cell") ? editable : null;
    if (cellEl) {
      const row = Number(cellEl.dataset.row);
      const col = Number(cellEl.dataset.col);
      handleCellInput(
        blockId,
        row,
        col,
        { currentTarget: cellEl } as React.FormEvent<HTMLDivElement>,
      );
    } else {
      updateTextBlockFromEl(blockId, editable);
    }
  };

  /** 选区变化 → 定位浮动工具条到选区上方（滚动/点击画布时关闭） */
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setFormatBar(null);
        return;
      }
      const node = sel.focusNode;
      const el = (
        node && node.nodeType === 1
          ? (node as HTMLElement)
          : ((node?.parentElement as HTMLElement) ?? null)
      ) as HTMLElement | null;
      const editable = el?.closest?.(".ff-text-editable, .ff-cell") as HTMLElement | null;
      if (!editable) {
        setFormatBar(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const blockId = editable.closest("[data-block-id]")?.getAttribute("data-block-id") ?? "";
      setFormatBar({
        x: rect.left + rect.width / 2,
        y: rect.top,
        blockId,
        inCell: editable.classList.contains("ff-cell"),
      });
    };
    const onScroll = () => setFormatBar(null);
    document.addEventListener("selectionchange", onSel);
    scrollRef.current?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      scrollRef.current?.removeEventListener("scroll", onScroll);
    };
  }, []);

  // ---------- 右键菜单内容 ----------

  const renderContextMenu = () => {
    if (!contextMenu) return null;
    const block = contextMenu.blockId
      ? blocksRef.current.find((b) => b.id === contextMenu.blockId)
      : null;
    const isTable = block?.type === "table" && contextMenu.row !== null && contextMenu.col !== null;
    const isInlineTable =
      block?.type === "text" &&
      contextMenu.inlineTableId !== null &&
      contextMenu.row !== null &&
      contextMenu.col !== null;
    // 菜单靠近屏幕边缘时向内收，避免溢出；高度按视口剩余空间自适应（内容多时菜单内部滚动）
    const MENU_W = 190;
    const menuLeft = Math.min(contextMenu.x, window.innerWidth - MENU_W);
    const menuTop = Math.max(4, Math.min(contextMenu.y, window.innerHeight - 48));
    const menuMaxH = Math.max(120, window.innerHeight - menuTop - 12);

    return (
      <div
        className="ff-menu"
        ref={menuRef}
        style={{
          left: Math.max(4, menuLeft),
          top: menuTop,
          maxHeight: menuMaxH,
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!block && (
          <>
            <button className="ff-menu-item" onClick={handleMenuInsertText}>
              插入文字
            </button>
            <button className="ff-menu-item" onClick={handleMenuInsertTable}>
              插入表格
            </button>
            {clipboardRef.current && (
              <>
                <div className="ff-menu-sep" />
                <button
                  className="ff-menu-item"
                  onClick={() => {
                    pasteBlocks(toPage(contextMenu.x, contextMenu.y));
                    setContextMenu(null);
                  }}
                >
                  粘贴
                </button>
              </>
            )}
          </>
        )}

        {block?.type === "text" && (
          <>
            <div className="ff-menu-group">插入</div>
            <button
              className="ff-menu-item"
              onClick={() => {
                // 内嵌到文字块当前光标处（光标不在块内则追加到末尾）
                const textEl = document.querySelector(
                  `[data-block-id="${block.id}"] .ff-text-editable`,
                ) as HTMLElement | null;
                if (textEl) insertInlineTableAtCaret(textEl, block.id);
                setContextMenu(null);
              }}
            >
              插入表格
            </button>
            <div className="ff-menu-group">字号</div>
            <div className="ff-menu-sizes">
              {FONT_SIZES.map((s) => (
                <button
                  key={s}
                  className="ff-menu-item ff-size-item"
                  onClick={() => setTextStyle(block.id, { fontSize: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="ff-menu-group">文字颜色</div>
            <div className="ff-menu-colors">
              {TEXT_COLORS.map((c) => (
                <button
                  key={c}
                  className="ff-color-dot"
                  style={{ background: c }}
                  title={c}
                  onClick={() => setTextStyle(block.id, { color: c })}
                />
              ))}
            </div>
            <div className="ff-menu-group">标题</div>
            <div className="ff-menu-sizes">
              <button
                className={`ff-menu-item ff-size-item ${!block.heading ? "active" : ""}`}
                onClick={() => setTextStyle(block.id, { heading: undefined })}
              >
                正文
              </button>
              {[1, 2, 3].map((h) => (
                <button
                  key={h}
                  className={`ff-menu-item ff-size-item ${block.heading === h ? "active" : ""}`}
                  onClick={() => setTextStyle(block.id, { heading: h })}
                >
                  H{h}
                </button>
              ))}
            </div>
            <div className="ff-menu-group">行高</div>
            <div className="ff-menu-sizes">
              {LINE_HEIGHTS.map((lh) => (
                <button
                  key={lh}
                  className={`ff-menu-item ff-size-item ${block.lineHeight === lh ? "active" : ""}`}
                  onClick={() => setTextStyle(block.id, { lineHeight: lh })}
                >
                  {lh}
                </button>
              ))}
            </div>
            <div className="ff-menu-group">背景色</div>
            <div className="ff-menu-colors">
              <button
                className="ff-color-dot ff-color-none"
                title="无背景"
                onClick={() => setTextStyle(block.id, { bgColor: undefined })}
              />
              {CELL_BG_COLORS.map((c) => (
                <button
                  key={c}
                  className="ff-color-dot"
                  style={{ background: c }}
                  title={c}
                  onClick={() => setTextStyle(block.id, { bgColor: c })}
                />
              ))}
            </div>
            <div className="ff-menu-group">边框</div>
            <div className="ff-menu-colors">
              <button
                className="ff-color-dot ff-color-none"
                title="无边框"
                onClick={() => setTextStyle(block.id, { borderColor: undefined })}
              />
              {BORDER_COLORS.map((c) => (
                <button
                  key={c}
                  className="ff-color-dot"
                  style={{ background: c }}
                  title={c}
                  onClick={() => setTextStyle(block.id, { borderColor: c })}
                />
              ))}
            </div>
          </>
        )}

        {(isTable || isInlineTable) && (
          <>
            <div className="ff-menu-group">表格</div>
            <button className="ff-menu-item" onClick={() => handleTableMenuAction("rowAbove")}>
              在上方插入行
            </button>
            <button className="ff-menu-item" onClick={() => handleTableMenuAction("rowBelow")}>
              在下方插入行
            </button>
            <button className="ff-menu-item" onClick={() => handleTableMenuAction("colLeft")}>
              在左侧插入列
            </button>
            <button className="ff-menu-item" onClick={() => handleTableMenuAction("colRight")}>
              在右侧插入列
            </button>
            <button className="ff-menu-item" onClick={() => handleTableMenuAction("delRow")}>
              删除当前行
            </button>
            <button className="ff-menu-item" onClick={() => handleTableMenuAction("delCol")}>
              删除当前列
            </button>
            {isTable && block.type === "table" && (
              <>
                <div className="ff-menu-sep" />
                <button
                  className="ff-menu-item"
                  onClick={() =>
                    setHeaderRows(
                      block.id,
                      (block.table!.headerRows ?? 0) > 0 ? 0 : 1,
                    )
                  }
                >
                  {(block.table!.headerRows ?? 0) > 0 ? "取消表头行" : "设为表头行"}
                </button>
                <div className="ff-menu-group">边框颜色</div>
                <div className="ff-menu-colors">
                  <button
                    className="ff-color-dot ff-color-none"
                    title="默认边框"
                    onClick={() => setTableBorderColor(block.id, undefined)}
                  />
                  {BORDER_COLORS.map((c) => (
                    <button
                      key={c}
                      className="ff-color-dot"
                      style={{ background: c }}
                      title={c}
                      onClick={() => setTableBorderColor(block.id, c)}
                    />
                  ))}
                </div>
                {contextMenu.row !== null && contextMenu.col !== null && (
                  <>
                    <div className="ff-menu-group">单元格底色</div>
                    <div className="ff-menu-colors">
                      <button
                        className="ff-color-dot ff-color-none"
                        title="无底色"
                        onClick={() =>
                          setCellBgColor(
                            block.id,
                            contextMenu.row!,
                            contextMenu.col!,
                            undefined,
                          )
                        }
                      />
                      {CELL_BG_COLORS.map((c) => (
                        <button
                          key={c}
                          className="ff-color-dot"
                          style={{ background: c }}
                          title={c}
                          onClick={() =>
                            setCellBgColor(block.id, contextMenu.row!, contextMenu.col!, c)
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {block && (
          <>
            <div className="ff-menu-sep" />
            <button
              className="ff-menu-item"
              onClick={() => {
                copyBlocks();
                setContextMenu(null);
              }}
            >
              复制
            </button>
            {clipboardRef.current && (
              <button
                className="ff-menu-item"
                onClick={() => {
                  pasteBlocks(toPage(contextMenu.x, contextMenu.y));
                  setContextMenu(null);
                }}
              >
                粘贴
              </button>
            )}
            <button
              className="ff-menu-item"
              onClick={() => setBlockProps(block.id, { locked: !block.locked })}
            >
              {block.locked ? "解锁" : "锁定"}
            </button>
            <button className="ff-menu-item" onClick={() => bringToFront(block.id)}>
              置于顶层
            </button>
            <button className="ff-menu-item" onClick={() => sendToBack(block.id)}>
              置于底层
            </button>
            <button
              className="ff-menu-item ff-menu-danger"
              onClick={() => deleteBlocks([block.id])}
            >
              删除{block.type === "table" ? "表格" : block.type === "text" ? "文字" : "内容"}
            </button>
          </>
        )}
      </div>
    );
  };

  // ---------- 渲染 ----------

  /** 浮动格式工具条当前作用块的样式值 */
  const formatBlock = formatBar
    ? blocks.find((b) => b.id === formatBar.blockId)
    : undefined;
  const formatBlockHeading = formatBlock?.heading ?? 0;

  return (
    <div className="freeform-editor">
      <div className="ff-toolbar">
        <div className="ff-mode-group">
          <button
            className={mode === "text" ? "ff-btn ff-icon-btn active" : "ff-btn ff-icon-btn"}
            onClick={() => setMode("text")}
            title="文字：点击画布任意位置直接输入"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 6h14" />
              <path d="M12 6v13" />
              <path d="M9.5 19h5" />
            </svg>
          </button>
          <button
            className={mode === "select" ? "ff-btn ff-icon-btn active" : "ff-btn ff-icon-btn"}
            onClick={() => setMode("select")}
            title="选择：框选 / 拖动已有内容"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 3l14 8.5-5.5 1.2L10.5 18 8 21z" />
            </svg>
          </button>
          <button
            className={mode === "draw" ? "ff-btn ff-icon-btn active" : "ff-btn ff-icon-btn"}
            onClick={() => setMode("draw")}
            title="画笔：在画布上自由涂鸦"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
              <path d="M13.5 6.5l4 4" />
            </svg>
          </button>
          <button
            className="ff-btn ff-icon-btn"
            onClick={() => fileRef.current?.click()}
            title="插入图片（也可 Ctrl+V 粘贴截图）"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" />
              <path d="M21 15l-5-5-8 8" />
            </svg>
          </button>
          <button
            className="ff-btn ff-icon-btn"
            onClick={() => insertTableFromCaret()}
            title="插入表格（光标在文字里时内嵌，否则放在点击处）"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 10h18" />
              <path d="M3 16h18" />
              <path d="M9.5 4v16" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={insertImage}
          />
        </div>

        {mode === "draw" && (
          <div className="ff-draw-options">
            {DRAW_COLORS.map((c) => (
              <span
                key={c}
                className={`ff-draw-color ${drawColor === c ? "active" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => setDrawColor(c)}
              />
            ))}
            <div className="ff-draw-widths">
              {DRAW_WIDTHS.map((w) => (
                <span
                  key={w}
                  className={`ff-draw-width ${drawWidth === w ? "active" : ""}`}
                  title={`粗细 ${w}`}
                  onClick={() => setDrawWidth(w)}
                >
                  <i style={{ width: Math.max(4, w * 2), height: Math.max(4, w * 2) }} />
                </span>
              ))}
            </div>
          </div>
        )}

        {selectedIds.length >= 2 && (
          <div className="ff-align-group">
            <button
              className="ff-btn ff-icon-btn"
              title="左对齐"
              onClick={() => alignBlocks("left")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h16M4 12h9M4 18h13" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="水平居中"
              onClick={() => alignBlocks("hcenter")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6h12M4 12h16M7 18h10" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="右对齐"
              onClick={() => alignBlocks("right")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h16M11 12h9M7 18h13" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="顶部对齐"
              onClick={() => alignBlocks("top")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 4h12M6 5v14M12 9v10M18 5v14" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="垂直居中"
              onClick={() => alignBlocks("vcenter")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 12h16M6 5v14M12 8v8M18 5v14" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="底部对齐"
              onClick={() => alignBlocks("bottom")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 20h12M6 5v15M12 10v10M18 5v15" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="水平均分"
              onClick={() => alignBlocks("hdist")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="7" width="3" height="10" rx="0.5" />
                <rect x="10.5" y="7" width="3" height="10" rx="0.5" />
                <rect x="17" y="7" width="3" height="10" rx="0.5" />
              </svg>
            </button>
            <button
              className="ff-btn ff-icon-btn"
              title="垂直均分"
              onClick={() => alignBlocks("vdist")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="7" y="4" width="10" height="3" rx="0.5" />
                <rect x="7" y="10.5" width="10" height="3" rx="0.5" />
                <rect x="7" y="17" width="10" height="3" rx="0.5" />
              </svg>
            </button>
          </div>
        )}

        <div className="ff-sep" />

        <div className="ff-zoom-group">
          <button
            className="ff-btn ff-icon-btn"
            onClick={undo}
            disabled={!canUndo}
            title="撤销 (Ctrl+Z)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14L4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
          <button
            className="ff-btn ff-icon-btn"
            onClick={redo}
            disabled={!canRedo}
            title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 14l5-5-5-5" />
              <path d="M20 9H10a6 6 0 0 0 0 12h3" />
            </svg>
          </button>
          <button className="ff-btn ff-icon-btn" onClick={zoomOut} title="缩小 (Ctrl+滚轮)">
            −
          </button>
          <span className="ff-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="ff-btn ff-icon-btn" onClick={zoomIn} title="放大 (Ctrl+滚轮)">
            +
          </button>
        </div>
        {(selectedId || selectedIds.length > 0) && (
          <button
            className="ff-btn ff-btn-danger"
            onClick={() => deleteBlocks(selectedIds.length ? selectedIds : [selectedId!])}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            删除
          </button>
        )}
      </div>

      <div className="ff-scroll" ref={scrollRef}>
        <div
          className="ff-page"
          ref={pageRef}
          style={{ width: PAGE_W * zoom, height: PAGE_H * zoom }}
          onPointerDown={handlePagePointerDown}
          onPointerMove={handlePagePointerMove}
          onPointerUp={handlePagePointerUp}
          onContextMenu={handlePageContextMenu}
        >
          <div className="ff-page-zoom" style={{ transform: `scale(${zoom})` }}>
            {blocks.map((block) => {
              const selected = selectedIds.includes(block.id);
              const primary = block.id === selectedId;
              const tW = block.type === "table" ? tableTotalWidth(block.table) : 0;
              return (
                <div
                  key={
                    block.type === "text" || block.type === "table"
                      ? `${block.id}:${ver}`
                      : block.id
                  }
                  className={`ff-block ${selected ? "ff-selected" : ""}`}
                  style={{
                    left: block.x,
                    top: block.y,
                    width: block.type === "table" ? tW : block.width,
                    minHeight: block.type === "text" || block.type === "table" ? 40 : undefined,
                    height:
                      block.type === "text" || block.type === "table" ? undefined : block.height,
                    background: block.bgColor,
                    border: block.borderColor ? `1.5px solid ${block.borderColor}` : undefined,
                    zIndex: block.z ?? 0,
                  }}
                  data-block-id={block.id}
                  onPointerDown={(e) => handleBlockDown(e, block)}
                  onContextMenu={(e) => handleBlockContextMenu(e, block)}
                >
                  {!block.locked && (block.type === "text" || block.type === "table") && (
                    <div
                      className="ff-move-handle"
                      title="拖动"
                      onPointerDown={(e) => startDrag(e, block)}
                    >
                      ⠿
                    </div>
                  )}

                  {block.locked && (
                    <span className="ff-lock-badge" title="已锁定（右键可解锁）">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        <rect x="5" y="11" width="14" height="9" rx="2" />
                      </svg>
                    </span>
                  )}

                  {block.type === "text" && (
                    <div
                      className="ff-text-editable"
                      contentEditable={!block.locked}
                      suppressContentEditableWarning
                      data-init=""
                      style={{
                        fontSize: block.heading
                          ? (HEADING_SIZES[block.heading] ?? DEFAULT_FONT_SIZE)
                          : (block.fontSize ?? DEFAULT_FONT_SIZE),
                        fontWeight: block.heading ? 600 : undefined,
                        color: block.color ?? DEFAULT_COLOR,
                        lineHeight: block.lineHeight,
                      }}
                      ref={(el) => {
                        if (el && !el.dataset.ready) {
                          el.dataset.ready = "1";
                          el.innerHTML = block.text ?? "";
                        }
                      }}
                      onInput={(e) => handleTextInput(block.id, e)}
                      onKeyDown={(e) => handleTextBlockKeyDown(e, block.id)}
                      onFocus={() => {
                        setEditingId(block.id);
                        if (!selectedIds.includes(block.id)) selectSingle(block.id);
                      }}
                      onBlur={() => handleTextBlur(block.id)}
                    />
                  )}

                  {block.type === "image" && (
                    <img
                      className="ff-image"
                      src={block.src}
                      draggable={false}
                      alt=""
                    />
                  )}

                  {block.type === "drawing" && (
                    <svg
                      className="ff-drawing"
                      width={block.width}
                      height={block.height}
                      viewBox={`0 0 ${block.width} ${block.height}`}
                    >
                      {block.paths?.map((p, i) => (
                        <path
                          key={i}
                          d={ptsToPath(p.points)}
                          stroke={p.color}
                          strokeWidth={p.width}
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                    </svg>
                  )}

                  {block.type === "table" && block.table && (
                    <table
                      className="ff-table"
                      style={{ width: tW }}
                      cellSpacing={0}
                    >
                      <tbody>
                        {block.table.cells.map((row, ri) => (
                          <tr
                            key={ri}
                            className={
                              ri < (block.table!.headerRows ?? 0) ? "ff-th-row" : undefined
                            }
                          >
                            {row.map((cell, ci) => (
                              <td
                                key={ci}
                                style={{
                                  width: block.table!.colWidths?.[ci] ?? DEFAULT_COL_WIDTH,
                                  border: block.table!.borderColor
                                    ? `1px solid ${block.table!.borderColor}`
                                    : undefined,
                                }}
                              >
                                <div
                                  className="ff-cell"
                                  contentEditable={!block.locked}
                                  suppressContentEditableWarning
                                  data-cell="1"
                                  data-row={ri}
                                  data-col={ci}
                                  style={{
                                    background: block.table!.cellBg?.[ri]?.[ci] || undefined,
                                  }}
                                  ref={(el) => {
                                    if (el && !el.dataset.ready) {
                                      el.dataset.ready = "1";
                                      el.innerHTML = cell ?? "";
                                    }
                                  }}
                                  onInput={(e) => handleCellInput(block.id, ri, ci, e)}
                                  onKeyDown={(e) => handleCellKeyDown(e, block.id, ri, ci)}
                                  onFocus={() => setEditingId(block.id)}
                                  onBlur={() => setEditingId(null)}
                                />
                                {/* 列宽拖拽手柄（悬停时出现） */}
                                {!block.locked && (
                                  <div
                                    className="ff-col-resizer"
                                    title="拖动调整列宽"
                                    onPointerDown={(e) => startColResize(e, block, ci)}
                                  />
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {selected && primary && !block.locked && block.type === "image" && (
                    <div
                      className="ff-resize"
                      title="调整大小"
                      onPointerDown={(e) => startResize(e, block)}
                    />
                  )}
                  {selected && primary && (
                    <button
                      className="ff-delete"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        deleteBlocks([block.id]);
                      }}
                      title="删除"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}

            {activeStroke && (
              <svg
                className="ff-active-stroke"
                width={PAGE_W}
                height={PAGE_H}
                viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
              >
                <path
                  d={ptsToPath(activeStroke.points)}
                  stroke={activeStroke.color}
                  strokeWidth={activeStroke.width}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}

            {marquee && (
              <div
                className="ff-marquee"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
          </div>
        </div>
      </div>

      {renderContextMenu()}

      {formatBar && (
        <div
          className="ff-format-bar"
          style={{ left: formatBar.x, top: formatBar.y - 8 }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <select
            className="ff-fbtn-select"
            value={formatBlockHeading}
            onChange={(e) =>
              setTextStyle(formatBar.blockId, {
                heading: Number(e.target.value) || undefined,
              })
            }
            title="标题样式"
          >
            <option value={0}>正文</option>
            <option value={1}>H1 标题</option>
            <option value={2}>H2 标题</option>
            <option value={3}>H3 标题</option>
          </select>
          <span className="ff-fsep" />
          <button className="ff-fbtn" onClick={() => runFormat("bold")} title="加粗 (Ctrl+B)">
            <b>B</b>
          </button>
          <button className="ff-fbtn" onClick={() => runFormat("italic")} title="斜体 (Ctrl+I)">
            <i>I</i>
          </button>
          <button className="ff-fbtn" onClick={() => runFormat("underline")} title="下划线 (Ctrl+U)">
            <u>U</u>
          </button>
          <div className="ff-format-colors" title="文字高亮">
            {HIGHLIGHT_COLORS.map((c) => (
              <span
                key={c}
                className="ff-format-color"
                style={{ background: c }}
                title={`高亮 ${c}`}
                onClick={() => runFormat("hiliteColor", c)}
              />
            ))}
          </div>
          <span className="ff-fsep" />
          <select
            className="ff-fbtn-select"
            value={
              blocks.find((b) => b.id === formatBar.blockId)?.fontSize ?? DEFAULT_FONT_SIZE
            }
            onChange={(e) =>
              setTextStyle(formatBar.blockId, { fontSize: Number(e.target.value) })
            }
            title="字号"
          >
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <div className="ff-format-colors">
            {TEXT_COLORS.map((c) => (
              <span
                key={c}
                className="ff-format-color"
                style={{ background: c }}
                title={c}
                onClick={() => runFormat("foreColor", c)}
              />
            ))}
          </div>
          <span className="ff-fsep" />
          <button className="ff-fbtn" onClick={() => runFormat("justifyLeft")} title="左对齐">
            ≡l
          </button>
          <button className="ff-fbtn" onClick={() => runFormat("justifyCenter")} title="居中">
            ≡c
          </button>
          <button className="ff-fbtn" onClick={() => runFormat("justifyRight")} title="右对齐">
            ≡r
          </button>
          <span className="ff-fsep" />
          <button
            className="ff-fbtn"
            onClick={() => runFormat("insertUnorderedList")}
            title="无序列表"
          >
            ≡
          </button>
          <button
            className="ff-fbtn"
            onClick={() => runFormat("insertOrderedList")}
            title="有序列表"
          >
            1.
          </button>
          <button
            className="ff-fbtn"
            onClick={() => runFormat("removeFormat")}
            title="清除格式"
          >
            Tx
          </button>
        </div>
      )}

      <div className="ff-hint">
        {mode === "text"
          ? "点击画布任意位置输入文字；选中文字可用加粗/斜体/列表；Ctrl+Z 撤销、Ctrl+D 复制内容"
          : mode === "draw"
            ? "按住鼠标在画布上自由涂鸦，松开结束；可切换颜色与粗细；Ctrl+Z 撤销"
            : "框选或 Ctrl+点选多个内容整体拖动；Ctrl+C/V 复制粘贴、Ctrl+D 复制副本、Delete 删除；Ctrl+Z 撤销"}
      </div>
    </div>
  );
}
