import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { documentsApi } from "../api";
import type { DocumentItem } from "../types";
import ConfirmDialog from "../components/ConfirmDialog";
import { toast } from "../components/Toaster";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // 待确认删除的资料（文件本体无法撤销，需二次确认）
  const [toDelete, setToDelete] = useState<DocumentItem | null>(null);

  async function refresh() {
    setDocs(await documentsApi.list());
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleImport() {
    const picked = await open({ multiple: false });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    try {
      await documentsApi.import(picked);
      await refresh();
      toast("资料已导入并加密保存");
    } catch (e) {
      console.error(e);
      toast(`导入失败：${e}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(doc: DocumentItem) {
    const dest = await save({ defaultPath: doc.fileName });
    if (!dest) return;
    setBusy(true);
    try {
      await documentsApi.export(doc.id, dest);
      toast("已导出到所选位置");
    } catch (e) {
      console.error(e);
      toast(`导出失败：${e}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await documentsApi.delete(toDelete.id);
      toast("资料已删除");
    } catch (e) {
      console.error(e);
      toast(`删除失败：${e}`, { kind: "error" });
    } finally {
      setBusy(false);
      setToDelete(null);
      refresh();
    }
  }

  if (loading) {
    return (
      <div className="page documents-page">
        <div className="documents-header">
          <h2>重要资料</h2>
        </div>
        <div className="skeleton-list skeleton-table">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton-row" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="page documents-page">
      <div className="documents-header">
        <h2>重要资料</h2>
        <button className="primary" onClick={handleImport} disabled={busy}>
          导入资料
        </button>
      </div>
      {docs.length === 0 ? (
        <div className="empty-state docs-empty">
          <div className="empty-state-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </div>
          <p className="empty-state-title">还没有资料</p>
          <p className="empty-state-hint">身份证、合同、证件照等重要文件，加密后随云端同步</p>
          <button className="primary" onClick={handleImport} disabled={busy}>
            导入资料
          </button>
        </div>
      ) : (
        <table className="documents-table">
          <thead>
            <tr>
              <th>标题</th>
              <th>文件名</th>
              <th>大小</th>
              <th>导入时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.title}</td>
                <td>{doc.fileName}</td>
                <td>{formatSize(doc.size)}</td>
                <td>{new Date(doc.createdAt).toLocaleString()}</td>
                <td className="doc-actions">
                  <button onClick={() => handleExport(doc)} disabled={busy}>
                    导出
                  </button>
                  <button
                    className="danger"
                    onClick={() => setToDelete(doc)}
                    disabled={busy}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {toDelete && (
        <ConfirmDialog
          title={`删除「${toDelete.title}」？`}
          message="删除后文件本体将从加密存储中移除，且无法恢复。请确认是否继续。"
          onCancel={() => setToDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
