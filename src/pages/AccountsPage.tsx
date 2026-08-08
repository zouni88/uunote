import { useEffect, useState } from "react";
import { accountsApi } from "../api";
import type { Account } from "../types";

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

  async function refresh() {
    setAccounts(await accountsApi.list());
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
    if (!form.title.trim()) return;
    if (editingId) {
      await accountsApi.update({ ...form, id: editingId } as Account);
    } else {
      await accountsApi.create({ ...form, id: "" } as Account);
    }
    setForm(emptyForm);
    setEditingId(null);
    refresh();
  }

  async function handleDelete() {
    if (!editingId) return;
    await accountsApi.delete(editingId);
    setForm(emptyForm);
    setEditingId(null);
    refresh();
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
        {accounts.length === 0 && <div className="empty-tip">暂无账号，点击"新增"录入</div>}
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
