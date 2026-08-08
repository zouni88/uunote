import { useEffect, useState } from "react";
import { accountsApi } from "../api";
import type { Account } from "../types";
import { toast, toastUndo } from "../components/Toaster";
import { consumePendingNavigate } from "../lib/events";

const emptyForm: Omit<Account, "id" | "createdAt" | "updatedAt"> = {
  title: "",
  username: "",
  password: "",
  url: "",
  notes: "",
};

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const list = await accountsApi.list();
    setAccounts(list);
    setLoading(false);
    // 处理命令面板跳转（数据就绪后选中目标账号）
    const target = consumePendingNavigate();
    if (target?.accountId) {
      const acc = list.find((a) => a.id === target.accountId);
      if (acc) handleSelect(acc);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleSelect(acc: Account) {
    setEditingId(acc.id);
    setForm({
      title: acc.title,
      username: acc.username,
      password: acc.password,
      url: acc.url,
      notes: acc.notes,
    });
  }

  async function handleSave() {
    if (!form.title.trim()) {
      toast("请填写名称", { kind: "error" });
      return;
    }
    try {
      if (editingId) {
        await accountsApi.update({ ...form, id: editingId } as Account);
        toast("账号已更新");
      } else {
        await accountsApi.create({ ...form, id: "" } as Account);
        toast("账号已保存");
      }
      setForm(emptyForm);
      setEditingId(null);
      refresh();
    } catch (e) {
      console.error(e);
      toast("保存失败，请重试", { kind: "error" });
    }
  }

  /** 删除账号（支持撤销：用已有字段重建） */
  async function handleDelete() {
    if (!editingId) return;
    const snapshot = accounts.find((a) => a.id === editingId);
    try {
      await accountsApi.delete(editingId);
      setForm(emptyForm);
      setEditingId(null);
      await refresh();
      if (snapshot) {
        toastUndo(`已删除「${snapshot.title}」`, () => restoreAccount(snapshot));
      }
    } catch (e) {
      console.error(e);
      toast("删除失败，请重试", { kind: "error" });
    }
  }

  /** 撤销删除：重建账号 */
  async function restoreAccount(snapshot: Account) {
    try {
      await accountsApi.create({
        title: snapshot.title,
        username: snapshot.username,
        password: snapshot.password,
        url: snapshot.url,
        notes: snapshot.notes,
      } as Account);
      await refresh();
      toast("账号已恢复");
    } catch (e) {
      console.error(e);
      toast("恢复失败", { kind: "error" });
    }
  }

  if (loading) {
    return (
      <div className="page accounts-page">
        <aside className="accounts-list">
          <div className="accounts-list-header"><span>账号列表</span></div>
          <div className="skeleton-list">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton skeleton-row" />
            ))}
          </div>
        </aside>
        <section className="account-form">
          <div className="skeleton skeleton-form" />
        </section>
      </div>
    );
  }

  return (
    <div className="page accounts-page">
      <aside className="accounts-list">
        <div className="accounts-list-header">
          <span>账号列表</span>
          <button onClick={() => { setEditingId(null); setForm(emptyForm); }}>新增</button>
        </div>
        {accounts.map((acc) => (
          <div
            key={acc.id}
            className={`account-item ${acc.id === editingId ? "active" : ""}`}
            onClick={() => handleSelect(acc)}
          >
            <div className="account-item-title">
              <span className="account-icon">
                {acc.title.trim().charAt(0).toUpperCase() || "?"}
              </span>
              {acc.title}
            </div>
            <div className="account-item-sub">{acc.username}</div>
          </div>
        ))}
        {accounts.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <p className="empty-state-title">还没有账号</p>
            <p className="empty-state-hint">保存网站、应用的用户名和密码，全部加密存储</p>
            <button
              className="primary"
              onClick={() => { setEditingId(null); setForm(emptyForm); }}
            >
              新增账号
            </button>
          </div>
        )}
      </aside>

      <section className="account-form">
        <div className="form-field">
          <label>名称</label>
          <input
            value={form.title}
            placeholder="如：GitHub / 邮箱"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label>用户名 / 邮箱</label>
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label>密码</label>
          <div className="password-row">
            <input
              type={showPassword ? "text" : "password"}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? "隐藏" : "显示"}
            </button>
          </div>
        </div>
        <div className="form-field">
          <label>网址</label>
          <input
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label>备注</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
        <div className="form-actions">
          <button className="primary" onClick={handleSave}>保存</button>
          {editingId && <button className="danger" onClick={handleDelete}>删除</button>}
        </div>
      </section>
    </div>
  );
}
