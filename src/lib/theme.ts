//! 主题管理：根据偏好（浅色/深色/跟随系统）设置 <html data-theme>，
//! 由 App.css 中 [data-theme="dark"] 变量覆盖实现深色主题。
//! 偏好持久化在后端（meta 表），此处负责读取与应用。

import { themeApi } from "../api";
import type { ThemeMode } from "../types";

const SYSTEM_QUERY = window.matchMedia("(prefers-color-scheme: dark)");

let currentMode: ThemeMode = "system";

export function getThemeMode(): ThemeMode {
  return currentMode;
}

/** 把偏好解析为实际生效的主题（跟随系统时按系统配色） */
function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (SYSTEM_QUERY.matches ? "dark" : "light") : mode;
}

/** 立即应用主题（锁屏、解锁后的主界面共享同一 data-theme） */
export function applyTheme(mode: ThemeMode): void {
  currentMode = mode;
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

/** 启动时从后端读取偏好并应用（读取失败时回退跟随系统） */
export async function initTheme(): Promise<void> {
  try {
    applyTheme(await themeApi.get());
  } catch {
    applyTheme("system");
  }
}

/** 切换偏好：先应用生效，再持久化（失败则回滚） */
export async function setTheme(mode: ThemeMode): Promise<void> {
  const prev = currentMode;
  applyTheme(mode);
  try {
    await themeApi.set(mode);
  } catch {
    applyTheme(prev);
    throw new Error("保存主题失败");
  }
}

/** 跟随系统时监听系统配色变化并实时切换 */
export function watchSystemTheme(): () => void {
  const onChange = () => {
    if (currentMode === "system") applyTheme("system");
  };
  SYSTEM_QUERY.addEventListener("change", onChange);
  return () => SYSTEM_QUERY.removeEventListener("change", onChange);
}
