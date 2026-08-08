import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { syncApi } from "../api";
import type { PageKey, SyncStatus } from "../types";

interface SidebarProps {
  current: PageKey;
  onChange: (page: PageKey) => void;
}

const items: { key: PageKey; label: string; icon: React.ReactNode }[] = [
  {
    key: "notes",
    label: "笔记",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  {
    key: "accounts",
    label: "账号",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    key: "documents",
    label: "资料",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
    ),
  },
  {
    key: "settings",
    label: "设置",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    key: "about",
    label: "关于",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    ),
  },
];

const syncLabels: Record<SyncStatus["state"], string> = {
  idle: "本地优先 · 加密同步",
  pending: "等待同步…",
  syncing: "正在同步…",
  synced: "已同步",
  error: "同步出错",
};

export default function Sidebar({ current, onChange }: SidebarProps) {
  // 同步状态：初始化拉取一次，此后由后端 sync://status 事件实时更新
  const [sync, setSync] = useState<SyncStatus>({ state: "idle", message: "本地优先 · 加密同步" });

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
    <nav className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-logo">U</div>
        <span>UUNote</span>
      </div>
      <ul className="sidebar-menu">
        {items.map((item) => (
          <li key={item.key}>
            <button
              className={`sidebar-item ${current === item.key ? "active" : ""}`}
              onClick={() => onChange(item.key)}
            >
              {item.icon}
              {item.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer" title={sync.message || syncLabels[sync.state]}>
        <span className={`sync-dot sync-${sync.state}`} />
        <span className="sync-label">{syncLabels[sync.state]}</span>
      </div>
    </nav>
  );
}
