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
const DEFAULT_COLOR = "#1f2937";

/** 右键菜单可选的文字字号 / 颜色 */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32];
const TEXT_COLORS = [
  "#1f2937", "#6b7280", "#b91c1c", "#ea580c",
  "#ca8a04", "#16a34a", "#2563eb", "#7c3aed",
];

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
      return data;
    }
  } catch {
    console.error("画布场景 JSON 解析失败", sceneJson.slice(0, 200));
  }
  return { version: 1, blocks: [] };
}

function ptsToPath(pts: [number, number][]): string {
  return pts
    .map((p, i) => `${i ? "L" : "M"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
}

function makeTable(rows: number, cols: number, colWidths: number[] = []): FreeformTable {
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  const widths = colWidths.length === cols ? colWidths : Array.from({ length: cols }, () => DEFAULT_COL_WIDTH);
  return { rows, cols, cells, colWidths: widths };
}

/** 表格总宽（各列宽之和） */
function tableTotalWidth(t?: FreeformTable): number {
  return t ? t.colWidths.reduce((a, b) => a + b, 0) : 0;
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

  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  /** 新文字块创建后需要聚焦的 id */
  const focusIdRef = useRef<string | null>(null);
  /** 新表格创建后需要聚焦首格的块 id（OneNote 式：插入即可直接输入） */
  const focusTableFirstCellRef = useRef<string | null>(null);
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

  const applyBlocks = useCallback(
    (next: FreeformBlock[]) => {
      setBlocks(next);
      emit(next);
    },
    [emit],
  );

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
          if (b.type === "text") {
            return { ...b, width: Math.max(80, Math.min(maxW, Math.round(r.origW + dx))) };
          }
          const nw = Math.max(80, Math.min(maxW, Math.round(r.origW + dx)));
          if (b.type === "table" && b.table) {
            // 表格整体缩放：按比例调整各列宽，行高跟随内容自适应
            const scale = nw / r.origW;
            return {
              ...b,
              width: nw,
              table: {
                ...b.table,
                colWidths: b.table.colWidths.map((cw) =>
                  Math.max(40, Math.round(cw * scale)),
                ),
              },
            };
          }
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
    const { x, y } = toPage(e.clientX, e.clientY);
    // 记住点击位置，供粘贴截图"点哪粘哪"使用
    lastClickRef.current = { x, y };
    // 空白处点击时清掉文本选区，避免残留光标把粘贴带进旧文字块（文字模式会新建块并重新聚焦）
    if (mode !== "text") window.getSelection()?.removeAllRanges();
    if (mode === "text") {
      addTextBlockAt(x, y);
    } else if (mode === "draw") {
      // 捕获指针，拖出画布仍能继续收集笔迹
      e.currentTarget.setPointerCapture(e.pointerId);
      setActiveStroke({
        points: [[x, y]],
        color: "#1e293b",
        width: 2.5,
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
      // 表格以实际渲染宽度为基准（增删列后 block.width 可能过期）
      origW: block.type === "table" && block.table ? tableTotalWidth(block.table) : block.width,
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

  /** 修改文字块样式（字号/颜色） */
  const setTextStyle = (id: string, patch: { fontSize?: number; color?: string }) => {
    applyBlocks(
      blocksRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
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
    setTableData(id, { ...t, rows: cells.length, cells });
    setContextMenu(null);
  };

  const insertCol = (id: string, at: number, dir: "left" | "right") => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table) return;
    const t = b.table;
    const cells = t.cells.map((row) => {
      const next = [...row];
      next.splice(dir === "left" ? at : at + 1, 0, "");
      return next;
    });
    const colWidths = [...t.colWidths];
    colWidths.splice(dir === "left" ? at : at + 1, 0, DEFAULT_COL_WIDTH);
    setTableData(id, { ...t, cols: cells[0].length, cells, colWidths });
    setContextMenu(null);
  };

  const deleteRow = (id: string, at: number) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table || b.table.rows <= 1) return;
    const t = b.table;
    const cells = t.cells.filter((_, ri) => ri !== at);
    setTableData(id, { ...t, rows: cells.length, cells });
    setContextMenu(null);
  };

  const deleteCol = (id: string, at: number) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.table || b.table.cols <= 1) return;
    const t = b.table;
    const cells = t.cells.map((row) => row.filter((_, ci) => ci !== at));
    const colWidths = t.colWidths.filter((_, ci) => ci !== at);
    setTableData(id, { ...t, cols: cells[0].length, cells, colWidths });
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
    // 菜单靠近屏幕边缘时向内收，避免溢出
    const MENU_W = 180;
    const MENU_H = 420;
    const menuLeft = Math.min(contextMenu.x, window.innerWidth - MENU_W);
    const menuTop = Math.min(contextMenu.y, window.innerHeight - MENU_H);

    return (
      <div
        className="ff-menu"
        ref={menuRef}
        style={{ left: Math.max(4, menuLeft), top: Math.max(4, menuTop) }}
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
          </>
        )}

        {block && (
          <button className="ff-menu-item ff-menu-danger" onClick={() => deleteBlocks([block.id])}>
            删除{block.type === "table" ? "表格" : block.type === "text" ? "文字" : "内容"}
          </button>
        )}
      </div>
    );
  };

  // ---------- 渲染 ----------

  return (
    <div className="freeform-editor">
      <div className="ff-toolbar">
        <div className="ff-mode-group">
          <button
            className={mode === "text" ? "ff-btn active" : "ff-btn"}
            onClick={() => setMode("text")}
            title="点击画布任意位置直接输入文字"
          >
            文字
          </button>
          <button
            className={mode === "select" ? "ff-btn active" : "ff-btn"}
            onClick={() => setMode("select")}
            title="选择/拖动已有内容"
          >
            选择
          </button>
          <button
            className={mode === "draw" ? "ff-btn active" : "ff-btn"}
            onClick={() => setMode("draw")}
            title="在画布上自由涂鸦"
          >
            画笔
          </button>
          <button
            className="ff-btn"
            onClick={() => fileRef.current?.click()}
            title="插入图片（也可 Ctrl+V 粘贴截图）"
          >
            图片
          </button>
          <button
            className="ff-btn"
            onClick={() => insertTableFromCaret()}
            title="插入表格（光标在文字里时内嵌在光标处，否则放在点击处）"
          >
            表格
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={insertImage}
          />
        </div>
        <div className="ff-zoom-group">
          <button className="ff-btn" onClick={zoomOut} title="缩小 (Ctrl+滚轮)">
            −
          </button>
          <span className="ff-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="ff-btn" onClick={zoomIn} title="放大 (Ctrl+滚轮)">
            +
          </button>
        </div>
        {(selectedId || selectedIds.length > 0) && (
          <button
            className="ff-btn ff-btn-danger"
            onClick={() => deleteBlocks(selectedIds.length ? selectedIds : [selectedId!])}
          >
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
                  key={block.id}
                  className={`ff-block ${selected ? "ff-selected" : ""}`}
                  style={
                    block.type === "text"
                      ? {
                          left: block.x,
                          top: block.y,
                          width: block.width,
                          minHeight: 40,
                        }
                      : block.type === "table"
                        ? {
                            left: block.x,
                            top: block.y,
                            width: tW,
                            minHeight: 40,
                          }
                        : {
                            left: block.x,
                            top: block.y,
                            width: block.width,
                            height: block.height,
                          }
                  }
                  data-block-id={block.id}
                  onPointerDown={(e) => handleBlockDown(e, block)}
                  onContextMenu={(e) => handleBlockContextMenu(e, block)}
                >
                  {(block.type === "text" || block.type === "table") && (
                    <div
                      className="ff-move-handle"
                      title="拖动"
                      onPointerDown={(e) => startDrag(e, block)}
                    >
                      ⠿
                    </div>
                  )}

                  {block.type === "text" && (
                    <div
                      className="ff-text-editable"
                      contentEditable
                      suppressContentEditableWarning
                      data-init=""
                      style={{
                        fontSize: block.fontSize ?? DEFAULT_FONT_SIZE,
                        color: block.color ?? DEFAULT_COLOR,
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
                      onBlur={() => setEditingId(null)}
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
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td
                                key={ci}
                                style={{ width: block.table!.colWidths[ci] ?? DEFAULT_COL_WIDTH }}
                              >
                                <div
                                  className="ff-cell"
                                  contentEditable
                                  suppressContentEditableWarning
                                  data-cell="1"
                                  data-row={ri}
                                  data-col={ci}
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
                                <div
                                  className="ff-col-resizer"
                                  title="拖动调整列宽"
                                  onPointerDown={(e) => startColResize(e, block, ci)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {selected && primary && block.type === "image" && (
                    <div
                      className="ff-resize"
                      title="调整大小"
                      onPointerDown={(e) => startResize(e, block)}
                    />
                  )}
                  {selected && primary && block.type === "table" && (
                    <div
                      className="ff-resize"
                      title="调整表格宽度"
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

      <div className="ff-hint">
        {mode === "text"
          ? "点击画布任意位置输入文字；在内容上右键可调整字号颜色、表格行列；Ctrl+V 直接粘贴截图"
          : mode === "draw"
            ? "按住鼠标在画布上自由涂鸦，松开结束；Ctrl+V 直接粘贴截图"
            : "框选或 Ctrl+点选多个内容整体拖动；拖表格列边框调列宽；Delete 删除；在内容上右键可编辑表格行列；Ctrl+V 直接粘贴截图"}
      </div>
    </div>
  );
}
