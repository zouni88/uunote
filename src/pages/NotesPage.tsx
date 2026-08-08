import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { notesApi } from "../api";
import type { Note } from "../types";
import ErrorBoundary from "../components/ErrorBoundary";

// 自由画布编辑器按需加载，避免拖慢启动
const FreeformEditor = lazy(() => import("../components/FreeformEditor"));

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState("");
  const blocksSaveTimer = useRef<number>(0);
  // 画布最新场景 JSON（画布改动可能尚未经 refresh 回流到 selected，保存时必须用最新值）
  const latestBlocksJson = useRef("");

  async function refresh() {
    setNotes(await notesApi.list());
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    return () => clearTimeout(blocksSaveTimer.current);
  }, []);

  const selected = notes.find((n) => n.id === selectedId) ?? null;

  async function handleSave() {
    const finalTitle = title.trim() || "无标题";
    try {
      if (selected) {
        // 画布笔记必须用 ref 里的最新场景，避免用列表里的旧值覆盖画布内容
        const updated = await notesApi.update({
          ...selected,
          title: finalTitle,
          blocks: latestBlocksJson.current,
        });
        setSelectedId(updated.id);
        // 保存后保持编辑状态，不关闭笔记
        setSaveStatus("已保存 " + new Date().toLocaleTimeString());
        await refresh();
      } else {
        const created = await notesApi.create(finalTitle);
        // 新笔记首次保存：把编辑器中已画的画布内容一并落库
        if (latestBlocksJson.current) {
          await notesApi.update({ ...created, blocks: latestBlocksJson.current });
        }
        setSelectedId(created.id);
        setEditing(true);
        setSaveStatus("已保存 " + new Date().toLocaleTimeString());
        await refresh();
      }
    } catch (err) {
      console.error("保存失败", err);
      alert("保存失败，请重试");
    }
  }

  async function handleNew() {
    await flushBlocksSave();
    setSelectedId(null);
    setTitle("");
    latestBlocksJson.current = "";
    setEditing(true);
  }

  async function handleSelect(note: Note) {
    // 切换前先落盘当前笔记的画布内容
    await flushBlocksSave();
    setSelectedId(note.id);
    setTitle(note.title);
    latestBlocksJson.current = note.blocks;
    setEditing(true);
  }

  async function handleDelete() {
    if (!selected) return;
    // 待保存的画布内容无需写入即将删除的笔记，直接清除定时器
    if (blocksSaveTimer.current) clearTimeout(blocksSaveTimer.current);
    blocksSaveTimer.current = 0;
    await notesApi.delete(selected.id);
    setSelectedId(null);
    setTitle("");
    setEditing(false);
    refresh();
  }

  async function handlePin(note: Note) {
    await notesApi.togglePinned(note.id);
    refresh();
  }

  /** 立即落盘当前笔记待保存的画布内容（切换笔记前调用，防止丢失） */
  async function flushBlocksSave() {
    if (!selected || !selectedId) return;
    if (blocksSaveTimer.current) {
      clearTimeout(blocksSaveTimer.current);
      blocksSaveTimer.current = 0;
      try {
        await notesApi.update({
          ...selected,
          blocks: latestBlocksJson.current,
        });
      } catch (e) {
        console.error("画布保存失败", e);
      }
    }
  }

  /** 画布内容防抖自动保存 */
  function handleSceneChange(json: string) {
    if (!selected) return;
    latestBlocksJson.current = json;
    clearTimeout(blocksSaveTimer.current);
    blocksSaveTimer.current = window.setTimeout(async () => {
      const current = notes.find((n) => n.id === selectedId);
      if (!current) return;
      try {
        await notesApi.update({
          ...current,
          blocks: latestBlocksJson.current,
        });
        setSaveStatus("已保存 " + new Date().toLocaleTimeString());
        refresh();
      } catch (e) {
        console.error("画布自动保存失败", e);
        setSaveStatus("保存失败");
      }
    }, 800);
  }

  if (loading) return <div className="page-loading">加载中…</div>;

  const sorted = [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <div className="page notes-page">
      <aside className="notes-list">
        <div className="notes-list-header">
          <span>我的笔记</span>
          <button onClick={handleNew}>新建</button>
        </div>
        {sorted.map((note) => (
          <div
            key={note.id}
            className={`note-item ${note.id === selectedId ? "active" : ""}`}
            onClick={() => handleSelect(note)}
          >
            <div className="note-item-title">
              {note.title || "无标题"}
              {note.pinned && <span className="pin-badge">📌</span>}
            </div>
            <div className="note-item-date">
              {new Date(note.updatedAt).toLocaleString()}
            </div>
          </div>
        ))}
        {sorted.length === 0 && <div className="empty-tip">暂无笔记，点击"新建"开始记录</div>}
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
                <span className="save-status">{saveStatus}</span>
                {selected && (
                  <button onClick={() => handlePin(selected)}>
                    {selected.pinned ? "取消置顶" : "置顶"}
                  </button>
                )}
                <button className="primary" onClick={handleSave}>保存</button>
                {selected && (
                  <button className="danger" onClick={handleDelete}>删除</button>
                )}
              </div>
            </div>
            <ErrorBoundary>
              <Suspense
                fallback={<div className="canvas-loading">画布加载中…</div>}
              >
                <FreeformEditor
                  key={selected?.id ?? "new-canvas"}
                  sceneJson={selected?.blocks ?? ""}
                  onSceneChange={handleSceneChange}
                  latestJsonRef={latestBlocksJson}
                />
              </Suspense>
            </ErrorBoundary>
          </>
        ) : (
          <div className="editor-placeholder">
            <div>
              <p className="placeholder-title">选择或新建一篇笔记</p>
              <p className="placeholder-hint">点击任意位置书写 · 自由摆放文字、图片、涂鸦</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
