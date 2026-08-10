//! 同步命令：配置保存 / 手动同步 / 状态查询 / 自动同步开关
//!
//! 手动同步（sync_push / sync_pull / sync_now）在后台线程执行，避免卡 UI；
//! 日常数据变更由命令层调用 sync::auto_commit 静默同步，无需用户干预。

use tauri::async_runtime::spawn_blocking;

use super::err;
use crate::db::meta;
use crate::sync::{self, SyncConfig};

#[tauri::command]
pub fn get_sync_config(app: tauri::AppHandle) -> Result<Option<SyncConfig>, String> {
    let st = super::state(&app);
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
    auto_sync: bool,
) -> Result<(), String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    sync::save_config(&conn, &repo_url, &branch, &token, &git_proxy).map_err(err)?;
    meta::set(&conn, "sync.auto", if auto_sync { "true" } else { "false" }).map_err(err)?;
    // 更新内存中的同步配置
    *st.repo_url.lock().unwrap() = repo_url.trim().trim_end_matches('/').to_string();
    *st.branch.lock().unwrap() = if branch.trim().is_empty() { "main" } else { branch.trim() }.to_string();
    *st.git_proxy.lock().unwrap() = git_proxy.trim().to_string();
    *st.sync_auto.lock().unwrap() = auto_sync;
    Ok(())
}

/// 查询当前同步状态（前端初始化时拉取一次，此后靠 sync://status 事件实时更新）
#[tauri::command]
pub fn get_sync_status(app: tauri::AppHandle) -> Result<crate::state::SyncStatus, String> {
    let st = super::state(&app);
    let status = st.sync_status.lock().unwrap().clone();
    Ok(status)
}

/// 切换自动同步开关（写入持久化配置并更新内存）
#[tauri::command]
pub fn set_auto_sync(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    meta::set(&conn, "sync.auto", if enabled { "true" } else { "false" }).map_err(err)?;
    *st.sync_auto.lock().unwrap() = enabled;
    Ok(())
}

/// 立即同步（拉取合并 + 推送，后台线程执行）
#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    spawn_blocking(move || push_sync(&st))
        .await
        .map_err(|e| e.to_string())?
}

fn push_sync(st: &crate::state::AppState) -> Result<String, String> {
    sync::push(st).map_err(err)
}

#[tauri::command]
pub async fn sync_push(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    spawn_blocking(move || push_sync(&st))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_pull(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    spawn_blocking(move || pull_sync(&st))
        .await
        .map_err(|e| e.to_string())?
}

fn pull_sync(st: &crate::state::AppState) -> Result<String, String> {
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
    sync::auto_sync(st).map_err(err)
}
