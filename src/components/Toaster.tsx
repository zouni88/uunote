//! 全局 Toast 通知：Notion 式底部轻提示，支持动作按钮（如"撤销"）。
//! 用法：
//!   toast("已保存");
//!   toast("删除失败", { kind: "error" });
//!   toastUndo("笔记已删除", () => restoreNote());
//! 在应用根部挂载 <Toaster />。

import { useEffect, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** 显示一个动作按钮（如"撤销"），点击执行并关闭当前提示 */
  actionLabel?: string;
  onAction?: () => void;
}

let push: ((item: ToastItem) => void) | null = null;
let nextId = 1;

export function toast(message: string, opts: ToastOptions = {}): void {
  push?.({
    id: nextId++,
    kind: opts.kind ?? "info",
    message,
    actionLabel: opts.actionLabel,
    onAction: opts.onAction,
  });
}

/** 删除类操作的快捷方式：提示 + 撤销动作 */
export function toastUndo(message: string, onUndo: () => void): void {
  toast(message, { kind: "success", actionLabel: "撤销", onAction: onUndo });
}

export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());

  function removeItem(id: number) {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  useEffect(() => {
    push = (item) => {
      setItems((prev) => [...prev.slice(-4), item]);
      // 带动作的提示保留更久，给用户足够反应时间
      const duration = item.onAction ? 6000 : 3000;
      timers.current.set(
        item.id,
        window.setTimeout(() => removeItem(item.id), duration)
      );
    };
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
      push = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function runAction(item: ToastItem) {
    removeItem(item.id);
    item.onAction?.();
  }

  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="toast-message">{t.message}</span>
          {t.actionLabel && (
            <button className="toast-action" onClick={() => runAction(t)}>
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
