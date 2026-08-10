import { useState } from "react";
import { setupMasterPassword, unlockApp } from "../api";
import WindowControls from "./WindowControls";

interface LockScreenProps {
  onUnlocked: () => void;
  /** 嵌入页面内显示（隐藏窗口控制，标题栏已提供） */
  embedded?: boolean;
  /** 初始模式：区分首次设置与解锁 */
  initialMode?: "unlock" | "setup";
}

export default function LockScreen({
  onUnlocked,
  embedded,
  initialMode = "unlock",
}: LockScreenProps) {
  const [mode, setMode] = useState<"unlock" | "setup">(initialMode);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setError("");
    if (mode === "setup") {
      if (password.length < 6) {
        setError("主密码至少 6 位");
        return;
      }
      if (password !== confirm) {
        setError("两次输入不一致");
        return;
      }
    }
    setLoading(true);
    try {
      if (mode === "setup") {
        const ok = await setupMasterPassword(password);
        if (ok) onUnlocked();
        else setError("初始化失败");
        return;
      }
      const ok = await unlockApp(password);
      if (ok) onUnlocked();
      else setError("密码错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="lock-screen">
      {!embedded && (
        <div className="lock-winctrl">
          <WindowControls />
        </div>
      )}
      <div className="lock-card">
        <div className="lock-brand">
          <span className="brand-logo">U</span> UUNote
        </div>
        <p className="lock-sub">
          {embedded ? "账号密码加密保存，输入主密码解锁后查看" : "你的加密笔记 · 账号 · 资料管家"}
        </p>
        <div className="lock-tabs">
          <button
            className={mode === "unlock" ? "active" : ""}
            disabled={loading}
            onClick={() => { setMode("unlock"); setError(""); }}
          >
            解锁
          </button>
          <button
            className={mode === "setup" ? "active" : ""}
            disabled={loading}
            onClick={() => { setMode("setup"); setError(""); }}
          >
            首次使用 · 设置主密码
          </button>
        </div>

        <input
          type="password"
          className="lock-input"
          placeholder={mode === "setup" ? "设置主密码（至少 6 位）" : "输入主密码"}
          value={password}
          disabled={loading}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
        {mode === "setup" && (
          <input
            type="password"
            className="lock-input"
            placeholder="确认主密码"
            value={confirm}
            disabled={loading}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
        )}
        {error && <p className="lock-error">{error}</p>}
        <button className="primary lock-submit" onClick={handleSubmit} disabled={loading}>
          {loading ? (
            <>
              <span className="lock-spinner" />
              {mode === "setup" ? "正在初始化…" : "正在解锁…"}
            </>
          ) : (
            mode === "setup" ? "初始化并进入" : "解锁"
          )}
        </button>
      </div>
    </div>
  );
}
