import { useEffect, useRef, useState } from "react";
import type { NoteEditMode } from "../types";
import {
  EDIT_MODES,
  EditModeIcon,
  getLastEditMode,
  saveLastEditMode,
} from "../lib/editModes";

interface NewNoteDialogProps {
  /** 新笔记所属分组（null = 未分组） */
  groupId: string | null;
  onCancel: () => void;
  /** 创建笔记：title 可为空字符串 */
  onCreate: (title: string, mode: NoteEditMode) => void;
}

/**
 * 新建笔记对话框：输入标题 + 选择编辑模式（记忆上次选择）
 * 现代卡片式设计：毛玻璃遮罩、模式卡片单选、入场动画
 */
export default function NewNoteDialog({
  groupId,
  onCancel,
  onCreate,
}: NewNoteDialogProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<NoteEditMode>(getLastEditMode());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const create = () => {
    saveLastEditMode(mode);
    onCreate(title.trim(), mode);
  };

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="new-note-dialog" role="dialog" aria-modal>
        <div className="dialog-header">
          <h3>新建笔记</h3>
          <p>选择编辑模式（创建后不可更改）</p>
        </div>

        <input
          ref={inputRef}
          className="dialog-title-input"
          value={title}
          placeholder="笔记标题（可留空，稍后修改）"
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />

        <div className="mode-cards">
          {EDIT_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`mode-card ${mode === m.key ? "active" : ""}`}
              onClick={() => setMode(m.key)}
              onDoubleClick={create}
            >
              <span className="mode-card-icon">
                <EditModeIcon mode={m.key} size={26} />
              </span>
              <span className="mode-card-label">{m.label}</span>
              <span className="mode-card-desc">{m.desc}</span>
              {mode === m.key && (
                <span className="mode-card-check">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="dialog-footer">
          <span className="dialog-group-hint">
            {groupId ? "将保存到当前分组" : "将保存到「未分组」"}
          </span>
          <div className="dialog-footer-actions">
            <button type="button" className="btn-ghost" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="primary" onClick={create}>
              创建笔记
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
