//! 笔记分组命令

use super::err;
use crate::db::groups::{self, NoteGroup};
use crate::sync;

#[tauri::command]
pub fn list_groups(app: tauri::AppHandle) -> Result<Vec<NoteGroup>, String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    groups::list(&conn).map_err(err)
}

#[tauri::command]
pub fn create_group(app: tauri::AppHandle, title: String) -> Result<NoteGroup, String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    let group = groups::create(&conn, &title).map_err(err)?;
    drop(conn);
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(group)
}

#[tauri::command]
pub fn rename_group(
    app: tauri::AppHandle,
    id: String,
    title: String,
) -> Result<Option<NoteGroup>, String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    let updated = groups::rename(&conn, &id, &title).map_err(err)?;
    drop(conn);
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(updated)
}

#[tauri::command]
pub fn delete_group(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    groups::delete(&conn, &id).map_err(err)?;
    drop(conn);
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(())
}
