/** 笔记（自由画布：文字块/图片块/涂鸦，OneNote 式自由摆放） */
export interface Note {
  id: string;
  title: string;
  /** 自由画布场景 JSON */
  blocks: string;
  pinned: boolean;
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
  /** text 块字号（px） */
  fontSize?: number;
  /** text 块文字颜色 */
  color?: string;
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
}

export type PageKey = "notes" | "accounts" | "documents" | "settings";
