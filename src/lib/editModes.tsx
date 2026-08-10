import type { NoteEditMode } from "../types";

/** 编辑模式元数据：新建对话框模式卡片共用 */
export interface EditModeMeta {
  key: NoteEditMode;
  label: string;
  /** 新建对话框里的说明 */
  desc: string;
}

export const EDIT_MODES: EditModeMeta[] = [
  {
    key: "freeform",
    label: "自由画布",
    desc: "文字、图片、涂鸦随意摆放，像纸张一样自由",
  },
  {
    key: "markdown",
    label: "Markdown",
    desc: "源码 + 实时预览，表格、任务清单，专业写作",
  },
  {
    key: "richtext",
    label: "富文本",
    desc: "所见即所得排版，标题、表格、图片一键插入",
  },
];

/** 上次新建时使用的模式（记忆用户习惯，下次新建默认选中） */
const LAST_MODE_KEY = "uunote.lastEditMode";

export function getLastEditMode(): NoteEditMode {
  const v = localStorage.getItem(LAST_MODE_KEY) as NoteEditMode | null;
  return v === "markdown" || v === "richtext" ? v : "freeform";
}

export function saveLastEditMode(mode: NoteEditMode) {
  localStorage.setItem(LAST_MODE_KEY, mode);
}

/** 编辑模式图标（线性风格，随主题色变化） */
export function EditModeIcon({
  mode,
  size = 22,
}: {
  mode: NoteEditMode;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {mode === "freeform" && (
        <>
          {/* 页面 + 自由摆放的块 */}
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13z" />
          <rect x="8" y="8" width="8" height="4.5" rx="1" />
          <circle cx="8.6" cy="15.6" r="1.4" />
          <rect x="12.4" y="14.6" width="3.6" height="2.6" rx="0.8" />
        </>
      )}
      {mode === "markdown" && (
        <>
          {/* Markdown M 标志 */}
          <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11z" />
          <path d="M6.5 15.5v-7l3 4 3-4v7" />
          <path d="M15.5 15.5v-7l-2.4 3M15.5 8.5l2.4 3v4" />
        </>
      )}
      {mode === "richtext" && (
        <>
          {/* 格式化文本 */}
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11z" />
          <path d="M7 9h10" />
          <path d="M12 9v6.5" />
          <path d="M9 15.5h6" />
        </>
      )}
    </svg>
  );
}
