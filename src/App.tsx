import { useEffect, useState } from "react";
import Sidebar from "./components/Sidebar";
import LockScreen from "./components/LockScreen";
import NotesPage from "./pages/NotesPage";
import AccountsPage from "./pages/AccountsPage";
import DocumentsPage from "./pages/DocumentsPage";
import SettingsPage from "./pages/SettingsPage";
import { isAppLocked } from "./api";
import type { PageKey } from "./types";
import "./App.css";

export default function App() {
  const [page, setPage] = useState<PageKey>("notes");
  const [locked, setLocked] = useState<boolean | null>(null);

  useEffect(() => {
    isAppLocked().then(setLocked);
  }, []);

  if (locked === null) return <div className="app-loading">启动中…</div>;
  if (locked) return <LockScreen onUnlocked={() => setLocked(false)} />;

  return (
    <div className="app-shell">
      <Sidebar current={page} onChange={setPage} />
      <main className="app-main">
        {page === "notes" && <NotesPage />}
        {page === "accounts" && <AccountsPage />}
        {page === "documents" && <DocumentsPage />}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
