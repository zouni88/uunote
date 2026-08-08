import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { documentsApi } from "../api";
import type { DocumentItem } from "../types";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setDocs(await documentsApi.list());
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
      refresh();
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
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    await documentsApi.delete(id);
    refresh();
  }

  return (
    <div className="page documents-page">
      <div className="documents-header">
        <h2>重要资料</h2>
        <button className="primary" onClick={handleImport} disabled={busy}>
          导入资料
        </button>
      </div>
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
                <button onClick={() => handleExport(doc)}>导出</button>
                <button className="danger" onClick={() => handleDelete(doc.id)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {docs.length === 0 && (
            <tr>
              <td colSpan={5} className="empty-tip">暂无资料，点击"导入资料"添加</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
