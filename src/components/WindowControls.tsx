//! 窗口控制按钮（最小化 / 最大化·还原 / 关闭），Windows 11 风格悬停效果。
//! 供自定义标题栏与锁屏共用；颜色全部走主题 CSS 变量，随浅色/深色自动变化。

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function WindowControls() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    // 窗口尺寸变化（最大化 / 还原）时同步按钮图标
    win
      .onResized(() => win.isMaximized().then(setMaximized).catch(() => {}))
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, [win]);

  return (
    <div className="tb-win-controls">
      <button className="tb-win-btn" title="最小化" onClick={() => win.minimize()}>
        <svg viewBox="0 0 10 10">
          <path d="M1 5h8" />
        </svg>
      </button>
      <button
        className="tb-win-btn"
        title={maximized ? "还原" : "最大化"}
        onClick={() => win.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10">
            <path d="M2.5 2.5V.5h7v7h-2" />
            <path d="M.5 3.5h6v6h-6z" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10">
            <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="0.75" />
          </svg>
        )}
      </button>
      <button className="tb-win-btn tb-close" title="关闭" onClick={() => win.close()}>
        <svg viewBox="0 0 10 10">
          <path d="M1 1l8 8M9 1l-8 8" />
        </svg>
      </button>
    </div>
  );
}
