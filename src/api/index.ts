import { invoke } from "@tauri-apps/api/core";
import type { Account, DocumentItem, Note, NoteGroup, SyncConfig, SyncStatus } from "../types";

/** 安全模式：设置/解锁主密码 */
export async function setupMasterPassword(password: string): Promise<boolean> {
  return invoke("setup_master_password", { password });
}

export async function unlockApp(password: string): Promise<boolean> {
  return invoke("unlock_app", { password });
}

export async function isAppLocked(): Promise<boolean> {
  return invoke("is_app_locked");
}

/** 修改主密码：验证旧密码后重加密全部敏感数据 */
export async function changeMasterPassword(
  oldPassword: string,
  newPassword: string
): Promise<void> {
  return invoke("change_master_password", { oldPassword, newPassword });
}

/** 笔记 */
export const notesApi = {
  list: () => invoke<Note[]>("list_notes"),
  create: (title: string, groupId?: string) =>
    invoke<Note>("create_note", { title, groupId }),
  update: (note: Note) => invoke<Note>("update_note", { note }),
  delete: (id: string) => invoke<void>("delete_note", { id }),
  togglePinned: (id: string) => invoke<Note>("toggle_pin_note", { id }),
};

/** 笔记分组 */
export const groupsApi = {
  list: () => invoke<NoteGroup[]>("list_groups"),
  create: (title: string) => invoke<NoteGroup>("create_group", { title }),
  rename: (id: string, title: string) =>
    invoke<NoteGroup | null>("rename_group", { id, title }),
  delete: (id: string) => invoke<void>("delete_group", { id }),
};

/** 账号 */
export const accountsApi = {
  list: () => invoke<Account[]>("list_accounts"),
  create: (account: Account) => invoke<Account>("create_account", { account }),
  update: (account: Account) => invoke<Account>("update_account", { account }),
  delete: (id: string) => invoke<void>("delete_account", { id }),
};

/** 重要资料 */
export const documentsApi = {
  list: () => invoke<DocumentItem[]>("list_documents"),
  import: (srcPath: string) => invoke<DocumentItem>("import_document", { srcPath }),
  export: (id: string, destPath: string) =>
    invoke<void>("export_document", { id, destPath }),
  delete: (id: string) => invoke<void>("delete_document", { id }),
};

/** 同步 */
export const syncApi = {
  config: () => invoke<SyncConfig | null>("get_sync_config"),
  saveConfig: (
    repoUrl: string,
    token: string,
    branch: string,
    gitProxy: string,
    autoSync: boolean
  ) => invoke<void>("save_sync_config", { repoUrl, token, branch, gitProxy, autoSync }),
  push: () => invoke<string>("sync_push"),
  pull: () => invoke<string>("sync_pull"),
  auto: () => invoke<string>("sync_auto"),
  /** 当前同步状态 */
  status: () => invoke<SyncStatus>("get_sync_status"),
  /** 切换自动同步 */
  setAutoSync: (enabled: boolean) => invoke<void>("set_auto_sync", { enabled }),
  /** 立即同步 */
  now: () => invoke<string>("sync_now"),
};

/** 数据存储位置 */
export const storageApi = {
  getDir: () => invoke<string>("get_data_dir"),
  setDir: (newDir: string) => invoke<string>("set_data_dir", { newDir }),
};
