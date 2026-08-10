/** 笔记编辑模式：自由画布 / Markdown / 富文本（创建时选定，之后锁定） */
export type NoteEditMode = "freeform" | "markdown" | "richtext";

/** 笔记 */
export interface Note {
  id: string;
  title: string;
  /** 编辑模式（决定打开笔记时用哪个编辑器），创建后不可切换 */
  mode: NoteEditMode;
  /** 当前模式下的内容：自由画布场景 JSON / Markdown 源码 / 富文本 HTML */
  content: string;
  pinned: boolean;
  /** 所属分组 id，null 表示未分组 */
  groupId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 笔记分组（二级结构：分组 → 笔记） */
export interface NoteGroup {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 自由画布元素 */
export interface FreeformBlock {
  id: string;
  type: "text" | "image" | "drawing" | "table";
  /** 相对画布左上角的坐标（未缩放） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** text 块内容 */
  text?: string;
  /** 手动调整过文字块宽度后锁定宽度（OneNote 式：不再随内容自动伸缩） */
  manualWidth?: boolean;
  /** text 块字号（px） */
  fontSize?: number;
  /** text 块文字颜色 */
  color?: string;
  /** text 块标题级别（1/2/3，无则为正文） */
  heading?: number;
  /** text 块行高倍数 */
  lineHeight?: number;
  /** 块背景色 */
  bgColor?: string;
  /** 块边框颜色（无则不描边） */
  borderColor?: string;
  /** 锁定：不可编辑/拖动/缩放 */
  locked?: boolean;
  /** 层级（越大越靠上，默认 0） */
  z?: number;
  /** image 块图片（data URL） */
  src?: string;
  /** drawing 块笔迹（相对块左上角） */
  paths?: FreeformPath[];
  /** table 块数据 */
  table?: FreeformTable;
}

export interface FreeformPath {
  points: [number, number][];
  color: string;
  width: number;
}

/** 表格数据：cells[row][col] */
export interface FreeformTable {
  rows: number;
  cols: number;
  cells: string[][];
  colWidths: number[];
  /** 前 N 行作为表头（加粗+底色） */
  headerRows?: number;
  /** 表格边框颜色 */
  borderColor?: string;
  /** 单元格底色（与 cells 同尺寸，可选） */
  cellBg?: string[][];
}

export interface FreeformScene {
  version: number;
  blocks: FreeformBlock[];
}

/** 账号条目 */
export interface Account {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** 重要资料 */
export interface DocumentItem {
  id: string;
  title: string;
  fileName: string;
  size: number;
  mime: string;
  createdAt: string;
  updatedAt: string;
}

/** GitHub 同步配置 */
export interface SyncConfig {
  repoUrl: string;
  branch: string;
  /** Git 代理地址（可选，如 http://127.0.0.1:7890） */
  gitProxy: string | null;
  lastSyncAt: string | null;
  /** Token 是否已保存到系统凭据管理器 */
  hasToken: boolean;
  /** 自动同步开关 */
  autoSync: boolean;
}

/** 同步状态（后端 sync://status 事件推送） */
export interface SyncStatus {
  state: "idle" | "pending" | "syncing" | "synced" | "error";
  message: string;
}

export type PageKey = "notes" | "accounts" | "documents" | "settings" | "about";

/** 主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = "light" | "dark" | "system";
