//! 同步命令：配置保存 / 推送 / 拉取（后台线程执行，避免卡 UI）

use tauri::async_runtime::spawn_blocking;

use super::err;
use crate::sync::{self, SyncConfig};

#[tauri::command]
pub fn get_sync_config(app: tauri::AppHandle) -> Result<Option<SyncConfig>, String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    sync::get_config(&conn).map_err(err)
}

#[tauri::command]
pub fn save_sync_config(
    app: tauri::AppHandle,
    repo_url: String,
    token: String,
    branch: String,
    git_proxy: String,
) -> Result<(), String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    sync::save_config(&conn, &repo_url, &branch, &token, &git_proxy).map_err(err)?;
    // 更新内存中的同步配置
    *st.repo_url.lock().unwrap() = repo_url.trim().trim_end_matches('/').to_string();
    *st.branch.lock().unwrap() = if branch.trim().is_empty() { "main" } else { branch.trim() }.to_string();
    *st.git_proxy.lock().unwrap() = git_proxy.trim().to_string();
    Ok(())
}

#[tauri::command]
pub async fn sync_push(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    spawn_blocking(move || push_sync(&st))
        .await
        .map_err(|e| e.to_string())?
}

fn push_sync(st: &crate::state::AppState) -> Result<String, String> {
    st.master_key().map_err(err)?;
    sync::push(st).map_err(err)
}

#[tauri::command]
pub async fn sync_pull(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    spawn_blocking(move || pull_sync(&st))
        .await
        .map_err(|e| e.to_string())?
}

fn pull_sync(st: &crate::state::AppState) -> Result<String, String> {
    st.master_key().map_err(err)?;
    sync::pull(st).map_err(err)
}

#[tauri::command]
pub async fn sync_auto(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    spawn_blocking(move || auto_sync(&st))
        .await
        .map_err(|e| e.to_string())?
}

fn auto_sync(st: &crate::state::AppState) -> Result<String, String> {
    st.master_key().map_err(err)?;
    sync::auto_sync(st).map_err(err)
}
