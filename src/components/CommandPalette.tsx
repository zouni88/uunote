//! Notion 式命令面板：Ctrl/Cmd+K 唤起，全局搜索笔记 / 账号并跳转。
//! 支持 ↑↓ 键盘导航、Enter 打开、Esc 关闭；空输入时展示最近编辑的笔记。

import { useEffect, useMemo, useRef, useState } from "react";
import { accountsApi, groupsApi, notesApi } from "../api";
import type { Account, Note } from "../types";
import { requestNavigate } from "../lib/events";

interface ResultItem {
  kind: "note" | "account";
  id: string;
  title: string;
  subtitle: string;
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开时刷新数据 + 清空查询
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    notesApi.list().then(setNotes).catch(() => {});
    accountsApi.list().then(setAccounts).catch(() => {});
    groupsApi.list().then((gs) => {
      const map: Record<string, string> = {};
      gs.forEach((g) => (map[g.id] = g.title));
      setGroupNames(map);
    });
    // 延迟聚焦，等面板动画渲染完成
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const q = query.trim().toLowerCase();

  const results: ResultItem[] = useMemo(() => {
    const noteItems = q
      ? notes.filter((n) => n.title.toLowerCase().includes(q))
      : // 空查询：展示最近编辑的笔记（按更新时间倒序取前 5）
        [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
    const noteResults: ResultItem[] = noteItems.map((n) => ({
      kind: "note",
      id: n.id,
      title: n.title || "无标题",
      subtitle: n.groupId ? groupNames[n.groupId] || "分组" : "未分组",
    }));
    const accountResults: ResultItem[] = q
      ? accounts
          .filter(
            (a) =>
              a.title.toLowerCase().includes(q) ||
              a.username.toLowerCase().includes(q) ||
              a.url.toLowerCase().includes(q)
          )
          .map((a) => ({
            kind: "account",
            id: a.id,
            title: a.title,
            subtitle: a.username || a.url || "账号",
          }))
      : [];
    return [...noteResults, ...accountResults];
  }, [q, notes, accounts, groupNames]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  if (!open) return null;

  function pick(item: ResultItem) {
    if (item.kind === "note") {
      requestNavigate({ page: "notes", noteId: item.id });
    } else {
      requestNavigate({ page: "accounts", accountId: item.id });
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[active];
      if (item) pick(item);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="palette-input-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="palette-search-icon">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索笔记、账号…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </div>
        <div className="palette-results">
          {results.length === 0 && (
            <div className="palette-empty">
              {q ? "没有匹配的结果" : "暂无笔记"}
            </div>
          )}
          {results.length > 0 && (
            <div className="palette-group">
              {!q && <div className="palette-group-title">最近编辑</div>}
              {results.map((item, i) => (
                <div
                  key={`${item.kind}-${item.id}`}
                  className={`palette-item ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(item)}
                >
                  <span className={`palette-item-icon ${item.kind}`}>
                    {item.kind === "note" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    )}
                  </span>
                  <span className="palette-item-body">
                    <span className="palette-item-title">{item.title}</span>
                    <span className="palette-item-sub">{item.subtitle}</span>
                  </span>
                  {i === active && <kbd className="palette-kbd">↵</kbd>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
