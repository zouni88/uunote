import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { groupsApi, notesApi } from "../api";
import type { Note, NoteEditMode, NoteGroup } from "../types";
import ErrorBoundary from "../components/ErrorBoundary";
import NewNoteDialog from "../components/NewNoteDialog";
import { toast, toastUndo } from "../components/Toaster";
import { consumePendingNavigate } from "../lib/events";
import { EDIT_MODES, EditModeIcon } from "../lib/editModes";

// 三种编辑器按需加载，避免拖慢启动
const FreeformEditor = lazy(() => import("../components/FreeformEditor"));
const MarkdownEditor = lazy(() => import("../components/MarkdownEditor"));
const RichTextEditor = lazy(() => import("../components/RichTextEditor"));

/** "未分组"区段的折叠键（分组 id 用不到该值，避免冲突） */
const UNGROUPED_KEY = "__ungrouped__";

/** 组内排序：置顶优先，其次按更新时间倒序 */
function sortNotes(list: Note[]): Note[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [groups, setGroups] = useState<NoteGroup[]>([]);
  const [title, setTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 当前新建笔记的目标分组（null = 未分组）
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // 折叠状态：key 为分组 id 或 UNGROUPED_KEY
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState("");
  // 正在重命名的分组
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // 内联新建分组输入
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupValue, setNewGroupValue] = useState("");
  // 拖拽目标分组（null = 未分组；拖拽中高亮）
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  // 右键菜单：group = 分组操作，list = 列表空白区域操作
  const [ctxMenu, setCtxMenu] = useState<{
    kind: "group" | "list";
    groupId?: string | null;
    x: number;
    y: number;
  } | null>(null);
  // 新建笔记对话框（groupId = 新笔记所属分组，null = 未分组）
  const [newNoteDlg, setNewNoteDlg] = useState<{
    open: boolean;
    groupId: string | null;
  }>({ open: false, groupId: null });
  const saveTimer = useRef<number>(0);
  // 当前笔记内容的最新值（编辑器改动可能尚未经 refresh 回流到 selected，保存时必须用最新值）
  const latestContent = useRef("");

  async function refresh() {
    const [noteList, groupList] = await Promise.all([
      notesApi.list(),
      groupsApi.list(),
    ]);
    setNotes(noteList);
    setGroups(groupList);
    setLoading(false);
    // 处理命令面板跳转（数据就绪后再打开目标笔记，避免时序竞态）
    const target = consumePendingNavigate();
    if (target?.noteId) {
      const note = noteList.find((n) => n.id === target.noteId);
      if (note) {
        setSelectedId(note.id);
        setTitle(note.title);
        latestContent.current = note.content;
        setEditing(true);
        const gid = note.groupId ?? null;
        setSelectedGroupId(gid);
        setCollapsed((c) => ({ ...c, [gid ?? UNGROUPED_KEY]: false }));
      }
    }
  }

  useEffect(() => {
    refresh();
    return () => clearTimeout(saveTimer.current);
  }, []);

  // 点击空白处 / Esc 关闭分组右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // 拖拽结束 / 放下后清除高亮
  useEffect(() => {
    const clear = () => setDragOverGroup(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  // 键盘快捷键：Ctrl+N 新建、Ctrl+S 保存、Delete 删除选中笔记
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase() ?? "";
      const typing = tag === "input" || tag === "textarea" || el?.isContentEditable;
      // 新建对话框打开时禁用全局新建/保存快捷键，避免干扰输入
      if (newNoteDlg.open) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNewNoteDialog(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Delete" && !typing && selected) {
        e.preventDefault();
        deleteNote(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selected = notes.find((n) => n.id === selectedId) ?? null;

  async function handleSave() {
    const finalTitle = title.trim() || "无标题";
    try {
      if (selected) {
        // 必须用 ref 里的最新内容，避免用列表里的旧值覆盖编辑器内容
        const updated = await notesApi.update({
          ...selected,
          title: finalTitle,
          content: latestContent.current,
        });
        setSelectedId(updated.id);
        // 保存后保持编辑状态，不关闭笔记
        setSaveStatus("已保存 " + new Date().toLocaleTimeString());
        await refresh();
      } else {
        // 新笔记落入当前选中的分组（未选中则为"未分组"）
        const created = await notesApi.create(
          finalTitle,
          "freeform",
          selectedGroupId ?? undefined
        );
        // 新笔记首次保存：把编辑器中已画的内容一并落库
        if (latestContent.current) {
          await notesApi.update({ ...created, content: latestContent.current });
        }
        setSelectedId(created.id);
        setEditing(true);
        setSaveStatus("已保存 " + new Date().toLocaleTimeString());
        await refresh();
      }
    } catch (err) {
      console.error("保存失败", err);
      toast("保存失败，请重试", { kind: "error" });
    }
  }

  /** 打开新建笔记对话框（groupId = 目标分组，null = 未分组） */
  function openNewNoteDialog(groupId: string | null) {
    setNewNoteDlg({ open: true, groupId });
  }

  /** 以指定模式创建笔记并立即进入对应编辑器（模式创建后锁定） */
  async function createNoteWithMode(title: string, mode: NoteEditMode) {
    const groupId = newNoteDlg.groupId;
    await flushSave();
    try {
      const created = await notesApi.create(title || "无标题", mode, groupId ?? undefined);
      setSelectedGroupId(groupId);
      setCollapsed((c) => ({ ...c, [groupId ?? UNGROUPED_KEY]: false }));
      setSelectedId(created.id);
      setTitle(created.title);
      latestContent.current = "";
      setEditing(true);
      setNewNoteDlg({ open: false, groupId: null });
      setSaveStatus("");
      await refresh();
    } catch (e) {
      console.error("新建笔记失败", e);
      toast("新建笔记失败，请重试", { kind: "error" });
    }
  }

  async function handleSelect(note: Note) {
    // 切换前先落盘当前笔记待保存的内容
    await flushSave();
    setSelectedId(note.id);
    setTitle(note.title);
    latestContent.current = note.content;
    setEditing(true);
    // 打开笔记时定位到其所在分组并展开
    const gid = note.groupId ?? null;
    setSelectedGroupId(gid);
    setCollapsed((c) => ({ ...c, [gid ?? UNGROUPED_KEY]: false }));
  }

  /** 删除笔记（支持撤销：重建一条相同内容的笔记，新 id 保证多设备同步安全） */
  async function deleteNote(note: Note) {
    // 若删除的是当前编辑中的笔记，清除其待保存定时器
    if (note.id === selectedId) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = 0;
      setSelectedId(null);
      setTitle("");
      setEditing(false);
    }
    const snapshot: Note = {
      ...note,
      content: note.id === selectedId ? latestContent.current : note.content,
    };
    try {
      await notesApi.delete(note.id);
      await refresh();
      toastUndo(`已删除「${note.title || "无标题"}」`, () => restoreNote(snapshot));
    } catch (e) {
      console.error(e);
      toast("删除失败，请重试", { kind: "error" });
    }
  }

  /** 撤销删除：重建笔记（标题 + 内容 + 模式 + 置顶 + 分组） */
  async function restoreNote(snapshot: Note) {
    try {
      const groupExists = groups.some((g) => g.id === snapshot.groupId);
      const created = await notesApi.create(
        snapshot.title || "无标题",
        snapshot.mode,
        groupExists ? (snapshot.groupId ?? undefined) : undefined
      );
      const patch: Partial<Note> = {};
      if (snapshot.content) patch.content = snapshot.content;
      if (snapshot.pinned) patch.pinned = true;
      await notesApi.update({ ...created, ...patch });
      await refresh();
      toast("笔记已恢复");
    } catch (e) {
      console.error(e);
      toast("恢复失败", { kind: "error" });
    }
  }

  async function handlePin(note: Note) {
    await notesApi.togglePinned(note.id);
    refresh();
  }

  /** 移动当前笔记到指定分组（空串 = 未分组） */
  async function moveNote(groupId: string) {
    if (!selected) return;
    const gid = groupId || null;
    await notesApi.update({ ...selected, groupId: gid });
    setSelectedGroupId(gid);
    setCollapsed((c) => ({ ...c, [gid ?? UNGROUPED_KEY]: false }));
    await refresh();
  }

  /** 拖拽笔记到分组（groupId 为 null = 未分组） */
  async function moveNoteToGroup(noteId: string, groupId: string | null) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    if ((note.groupId ?? null) === groupId) return;
    // 拖拽的是当前编辑笔记时，用编辑器最新内容，避免丢失未保存的改动
    const isCurrent = note.id === selectedId;
    const patch: Partial<Note> = {};
    if (isCurrent) {
      patch.content = latestContent.current;
    }
    await notesApi.update({ ...note, groupId, ...patch });
    setSelectedGroupId(groupId);
    setCollapsed((c) => ({ ...c, [groupId ?? UNGROUPED_KEY]: false }));
    await refresh();
  }

  /** 在指定分组内新建笔记：弹出模式选择对话框 */
  function createNoteInGroup(groupId: string) {
    openNewNoteDialog(groupId);
  }

  /** 打开内联"新建分组"输入 */
  function openNewGroup() {
    setNewGroupValue("");
    setNewGroupOpen(true);
  }

  /** 提交内联新建分组 */
  async function commitNewGroup() {
    const name = newGroupValue.trim();
    setNewGroupOpen(false);
    if (!name) return;
    try {
      const g = await groupsApi.create(name);
      await refresh();
      // 展开新分组并选中，方便立即使用
      setCollapsed((c) => ({ ...c, [g.id]: false }));
      setSelectedGroupId(g.id);
      toast("分组已创建");
    } catch (e) {
      console.error(e);
      toast("创建分组失败", { kind: "error" });
    }
  }

  function startRename(group: NoteGroup) {
    setRenamingGroupId(group.id);
    setRenameValue(group.title);
  }

  async function commitRename(group: NoteGroup) {
    const name = renameValue.trim();
    setRenamingGroupId(null);
    if (name && name !== group.title) {
      await groupsApi.rename(group.id, name);
      await refresh();
    }
  }

  /** 删除分组（组内笔记移到"未分组"；支持撤销：重建分组并归还笔记） */
  async function removeGroup(group: NoteGroup) {
    const memberIds = notes.filter((n) => n.groupId === group.id).map((n) => n.id);
    try {
      await groupsApi.delete(group.id);
      if (selectedGroupId === group.id) setSelectedGroupId(null);
      await refresh();
      toastUndo(`已删除分组「${group.title}」`, () => restoreGroup(group, memberIds));
    } catch (e) {
      console.error(e);
      toast("删除分组失败", { kind: "error" });
    }
  }

  /** 撤销删除分组：重建分组，并把当时组内笔记归还 */
  async function restoreGroup(group: NoteGroup, memberIds: string[]) {
    try {
      const g = await groupsApi.create(group.title);
      for (const id of memberIds) {
        const n = notes.find((x) => x.id === id);
        if (n) await notesApi.update({ ...n, groupId: g.id });
      }
      await refresh();
      toast("分组已恢复");
    } catch (e) {
      console.error(e);
      toast("恢复失败", { kind: "error" });
    }
  }

  function toggleCollapse(key: string) {
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  }

  /** 打开分组右键菜单（groupId 为 null 表示"未分组"） */
  function openGroupMenu(e: React.MouseEvent, groupId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    // 菜单宽度约 150px、高度约 140px，贴边时向内收，避免溢出窗口
    const x = Math.min(e.clientX, window.innerWidth - 170);
    const y = Math.min(e.clientY, window.innerHeight - 150);
    setCtxMenu({ kind: "group", groupId, x, y });
  }

  /** 列表空白区域右键菜单（新建分组 / 新建笔记） */
  function openListMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 170);
    const y = Math.min(e.clientY, window.innerHeight - 150);
    setCtxMenu({ kind: "list", x, y });
  }

  /** 在指定分组（null = 未分组）新建笔记：弹出模式选择对话框 */
  function startNewIn(groupId: string | null) {
    openNewNoteDialog(groupId);
  }

  const ctxGroup =
    ctxMenu?.kind === "group" && ctxMenu.groupId
      ? groups.find((g) => g.id === ctxMenu.groupId) ?? null
      : null;

  /** 立即落盘当前笔记待保存的内容（切换笔记/新建前调用，防止丢失） */
  async function flushSave() {
    if (!selected || !selectedId) return;
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    try {
      await notesApi.update({
        ...selected,
        content: latestContent.current,
      });
    } catch (e) {
      console.error("笔记保存失败", e);
    }
  }

  /** 内容防抖自动保存（编辑器变更统一走这里，按模式写入对应内容） */
  function handleContentChange(content: string) {
    if (!selected) return;
    latestContent.current = content;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const current = notes.find((n) => n.id === selectedId);
      if (!current) return;
      try {
        await notesApi.update({
          ...current,
          content: latestContent.current,
        });
        setSaveStatus("已保存 " + new Date().toLocaleTimeString());
        refresh();
      } catch (e) {
        console.error("自动保存失败", e);
        setSaveStatus("保存失败");
      }
    }, 800);
  }

  if (loading) {
    return (
      <div className="page notes-page">
        <aside className="notes-list">
          <div className="notes-list-header">
            <span>我的笔记</span>
          </div>
          <div className="skeleton-list">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton skeleton-row" />
            ))}
          </div>
        </aside>
        <section className="notes-editor">
          <div className="skeleton skeleton-canvas" />
        </section>
      </div>
    );
  }

  const ungroupedNotes = sortNotes(notes.filter((n) => !n.groupId));
  const isEmpty = notes.length === 0 && groups.length === 0;

  /** 笔记条目（列表项 + hover 快捷操作 + 拖拽） */
  function renderNoteItem(note: Note) {
    return (
      <div
        key={note.id}
        className={`note-item note-child ${note.id === selectedId ? "active" : ""}`}
        onClick={() => handleSelect(note)}
        onContextMenu={(e) => e.stopPropagation()}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", note.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <div className="note-item-main">
          <div className="note-item-title">
            {note.title || "无标题"}
            {note.pinned && (
              <svg className="pin-badge-icon" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
              </svg>
            )}
          </div>
          <div className="note-item-date">
            {new Date(note.updatedAt).toLocaleString()}
          </div>
        </div>
        <div className="note-item-actions">
          <button
            className="note-action"
            title={note.pinned ? "取消置顶" : "置顶"}
            onClick={(e) => {
              e.stopPropagation();
              handlePin(note);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
            </svg>
          </button>
          <button
            className="note-action danger"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              deleteNote(note);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  /** 分组节点（标题行 + 组内笔记），同时作为拖拽放置目标 */
  function renderGroupNode(key: string, groupLabel: string, list: Note[], opts: {
    isUngrouped?: boolean;
    onTitleClick?: () => void;
    onPlus?: () => void;
  }) {
    const isCollapsed = !!collapsed[key];
    const isDropTarget = dragOverGroup === key;
    const activeKey = opts.isUngrouped ? null : key;
    return (
      <div
        className={`group-node ${isDropTarget ? "drop-target" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/plain")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOverGroup(key);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData("text/plain");
          const gid = opts.isUngrouped ? null : key;
          if (id) moveNoteToGroup(id, gid);
        }}
      >
        <div
          className={`group-row ${selectedGroupId === activeKey ? "active" : ""}`}
          onClick={opts.onTitleClick}
          onContextMenu={(e) => openGroupMenu(e, opts.isUngrouped ? null : key)}
        >
          <span
            className={`group-caret ${isCollapsed ? "" : "open"}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(key);
            }}
          >
            ▸
          </span>
          <span className="group-title">{groupLabel}</span>
          <span className="group-count">{list.length}</span>
          <div className="group-actions">
            {opts.onPlus && (
              <button
                className="group-action"
                title="在此分组新建笔记"
                onClick={(e) => {
                  e.stopPropagation();
                  opts.onPlus!();
                }}
              >
                ＋
              </button>
            )}
          </div>
        </div>
        {!isCollapsed && list.map(renderNoteItem)}
      </div>
    );
  }

  return (
    <div className="page notes-page">
      <aside className="notes-list" onContextMenu={openListMenu}>
        <div className="notes-list-header">
          <span>我的笔记</span>
          <div className="notes-list-actions">
            <button className="header-btn" onClick={openNewGroup} title="新建分组">
              ＋分组
            </button>
            <button className="header-btn primary" onClick={() => openNewNoteDialog(null)} title="新建笔记">
              ＋笔记
            </button>
          </div>
        </div>
        <div className="notes-tree">
          {isEmpty && (
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </div>
              <p className="empty-state-title">开始你的第一篇笔记</p>
              <p className="empty-state-hint">支持自由画布、Markdown、富文本三种编辑模式</p>
              <button className="primary" onClick={() => openNewNoteDialog(null)}>
                新建笔记
              </button>
            </div>
          )}

          {!isEmpty &&
            renderGroupNode(UNGROUPED_KEY, "未分组", ungroupedNotes, {
              isUngrouped: true,
              onTitleClick: () => setSelectedGroupId(null),
              onPlus: () => openNewNoteDialog(null),
            })}

          {groups.map((group) => {
            const list = sortNotes(notes.filter((n) => n.groupId === group.id));
            const isRenaming = renamingGroupId === group.id;
            return (
              <div
                key={group.id}
                className={`group-node ${dragOverGroup === group.id ? "drop-target" : ""}`}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("text/plain")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverGroup(group.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) moveNoteToGroup(id, group.id);
                }}
              >
                <div
                  className={`group-row ${selectedGroupId === group.id ? "active" : ""}`}
                  onContextMenu={(e) => openGroupMenu(e, group.id)}
                >
                  <span
                    className={`group-caret ${isRenaming || collapsed[group.id] ? "" : "open"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(group.id);
                    }}
                  >
                    ▸
                  </span>
                  {isRenaming ? (
                    <input
                      className="group-rename-input"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(group)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(group);
                        if (e.key === "Escape") setRenamingGroupId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="group-title"
                      onClick={() => setSelectedGroupId(group.id)}
                    >
                      {group.title}
                    </span>
                  )}
                  <span className="group-count">{list.length}</span>
                  <div className="group-actions">
                    <button
                      className="group-action"
                      title="在此分组新建笔记"
                      onClick={(e) => {
                        e.stopPropagation();
                        createNoteInGroup(group.id);
                      }}
                    >
                      ＋
                    </button>
                    <button
                      className="group-action"
                      title="重命名分组"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(group);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="group-action"
                      title="删除分组"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeGroup(group);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {!collapsed[group.id] && list.map(renderNoteItem)}
              </div>
            );
          })}

          {newGroupOpen ? (
            <div className="group-row new-group-row">
              <input
                className="group-rename-input"
                value={newGroupValue}
                placeholder="分组名称，回车确认"
                autoFocus
                onChange={(e) => setNewGroupValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNewGroup();
                  if (e.key === "Escape") setNewGroupOpen(false);
                }}
                onBlur={() => commitNewGroup()}
              />
            </div>
          ) : (
            !isEmpty && (
              <button className="add-group-btn" onClick={openNewGroup}>
                ＋ 新建分组
              </button>
            )
          )}
        </div>
      </aside>

      <section className="notes-editor">
        {editing ? (
          <>
            <div className="editor-toolbar">
              <input
                className="editor-title-input"
                value={title}
                placeholder="笔记标题"
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="toolbar-actions">
                {selected && (
                  <>
                    <div className="mode-badge" title="创建时选定的模式，不可切换">
                      <EditModeIcon mode={selected.mode} size={14} />
                      {EDIT_MODES.find((m) => m.key === selected.mode)?.label}
                    </div>
                    <select
                      className="group-select"
                      value={selected.groupId ?? ""}
                      onChange={(e) => moveNote(e.target.value)}
                      title="移动笔记到分组"
                    >
                      <option value="">未分组</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.title}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <span className="save-status">{saveStatus}</span>
                {selected && (
                  <button
                    className={`icon-btn ${selected.pinned ? "pinned" : ""}`}
                    title={selected.pinned ? "取消置顶" : "置顶"}
                    onClick={() => handlePin(selected)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                    </svg>
                  </button>
                )}
                <button className="primary" onClick={handleSave}>保存</button>
                {selected && (
                  <button className="danger" onClick={() => deleteNote(selected)}>删除</button>
                )}
              </div>
            </div>
            <ErrorBoundary>
              <Suspense
                fallback={<div className="canvas-loading">编辑器加载中…</div>}
              >
                {selected && selected.mode === "markdown" ? (
                  <MarkdownEditor
                    key={`${selected.id}-md`}
                    value={selected.content}
                    onChange={handleContentChange}
                  />
                ) : selected && selected.mode === "richtext" ? (
                  <RichTextEditor
                    key={`${selected.id}-rt`}
                    value={selected.content}
                    onChange={handleContentChange}
                  />
                ) : (
                  <FreeformEditor
                    key={selected?.id ?? "new-canvas"}
                    sceneJson={selected?.content ?? ""}
                    onSceneChange={handleContentChange}
                    latestJsonRef={latestContent}
                  />
                )}
              </Suspense>
            </ErrorBoundary>
          </>
        ) : (
          <div className="editor-placeholder">
            <div>
              <p className="placeholder-title">选择或新建一篇笔记</p>
              <p className="placeholder-hint">Ctrl + N 快速新建 · Ctrl + K 全局搜索</p>
              <button className="primary" onClick={() => openNewNoteDialog(null)}>
                新建笔记
              </button>
            </div>
          </div>
        )}
      </section>

      {ctxMenu && (
        <div
          className="group-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.kind === "group" ? (
            <>
              <button
                className="group-menu-item"
                onClick={() => {
                  startNewIn(ctxMenu.groupId ?? null);
                  setCtxMenu(null);
                }}
              >
                ＋ 新建笔记
              </button>
              {ctxGroup && (
                <>
                  <button
                    className="group-menu-item"
                    onClick={() => {
                      startRename(ctxGroup);
                      setCtxMenu(null);
                    }}
                  >
                    重命名分组
                  </button>
                  <button
                    className="group-menu-item danger"
                    onClick={() => {
                      removeGroup(ctxGroup);
                      setCtxMenu(null);
                    }}
                  >
                    删除分组
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                className="group-menu-item"
                onClick={() => {
                  openNewGroup();
                  setCtxMenu(null);
                }}
              >
                ＋ 新建分组
              </button>
              <button
                className="group-menu-item"
                onClick={() => {
                  openNewNoteDialog(null);
                  setCtxMenu(null);
                }}
              >
                ＋ 新建笔记
              </button>
            </>
          )}
        </div>
      )}

      {newNoteDlg.open && (
        <NewNoteDialog
          groupId={newNoteDlg.groupId}
          onCancel={() => setNewNoteDlg({ open: false, groupId: null })}
          onCreate={createNoteWithMode}
        />
      )}
    </div>
  );
}
