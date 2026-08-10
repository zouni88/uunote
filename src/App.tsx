import { useEffect, useState } from "react";
import Titlebar from "./components/Titlebar";
import Toaster from "./components/Toaster";
import CommandPalette from "./components/CommandPalette";
import NotesPage from "./pages/NotesPage";
import AccountsPage from "./pages/AccountsPage";
import DocumentsPage from "./pages/DocumentsPage";
import SettingsPage from "./pages/SettingsPage";
import AboutPage from "./pages/AboutPage";
import { on } from "./lib/events";
import { watchSystemTheme } from "./lib/theme";
import type { NavigateTarget } from "./lib/events";
import type { PageKey } from "./types";
import "./App.css";

export default function App() {
  const [page, setPage] = useState<PageKey>("notes");
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 跟随系统时监听系统配色变化（由 lib/theme 统一处理并应用）
  useEffect(() => watchSystemTheme(), []);

  // 命令面板跳转请求（Cmd+K 搜索结果）
  useEffect(() => {
    const off = on("navigate", (p) => {
      const target = p as NavigateTarget;
      setPage(target.page);
    });
    return off;
  }, []);

  // 全局快捷键：Ctrl/Cmd+K 打开命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <Titlebar page={page} onOpenPalette={() => setPaletteOpen(true)} />
      <main className="app-main">
        {page === "notes" && <NotesPage />}
        {page === "accounts" && <AccountsPage />}
        {page === "documents" && <DocumentsPage />}
        {page === "settings" && <SettingsPage />}
        {page === "about" && <AboutPage />}
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toaster />
    </div>
  );
}
