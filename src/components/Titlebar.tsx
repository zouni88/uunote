//! Notion 式自定义标题栏：替代系统标题栏，颜色随主题变化。
//! 左侧：当前页面图标（点击弹出页面切换菜单）；中间：全局搜索入口（打开命令面板）；
//! 右侧：同步状态 + 窗口控制。
//! 空白区域通过 data-tauri-drag-region="deep" 支持拖拽移动窗口（双击最大化）。

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { syncApi } from "../api";
import { requestNavigate } from "../lib/events";
import type { PageKey, SyncStatus } from "../types";
import WindowControls from "./WindowControls";

const pageLabels: Record<PageKey, string> = {
  notes: "笔记",
  accounts: "账号",
  documents: "资料",
  settings: "设置",
  about: "关于",
};

const pageOrder: PageKey[] = ["notes", "accounts", "documents", "settings", "about"];

/** 与侧边栏一致的页面图标 */
const pageIcons: Record<PageKey, React.ReactNode> = {
  notes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  accounts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  documents: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  ),
};

interface TitlebarProps {
  page: PageKey;
  onOpenPalette: () => void;
}

export default function Titlebar({ page, onOpenPalette }: TitlebarProps) {
  const [sync, setSync] = useState<SyncStatus>({ state: "idle", message: "" });
  const [menuOpen, setMenuOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  // 点击菜单外部时关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // 同步状态：初始化拉取一次，此后由后端 sync://status 事件实时更新
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    syncApi
      .status()
      .then(setSync)
      .catch(() => {});
    listen<SyncStatus>("sync://status", (e) => setSync(e.payload))
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="tb-page-switcher" ref={switcherRef}>
        <button
          className="tb-btn tb-page-icon"
          title={pageLabels[page]}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {pageIcons[page]}
        </button>
        {menuOpen && (
          <div className="tb-page-menu">
            {pageOrder.map((key) => (
              <button
                key={key}
                className={`tb-page-item ${page === key ? "active" : ""}`}
                onClick={() => {
                  setMenuOpen(false);
                  requestNavigate({ page: key });
                }}
              >
                {pageIcons[key]}
                <span>{pageLabels[key]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="tb-search" onClick={onOpenPalette} title="全局搜索（Ctrl/Cmd + K）">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span>搜索笔记、账号…</span>
        <kbd className="tb-kbd">⌘K</kbd>
      </button>

      <div className="tb-right">
        <span className={`sync-dot sync-${sync.state}`} title={sync.message || "同步状态"} />
        <WindowControls />
      </div>
    </header>
  );
}
