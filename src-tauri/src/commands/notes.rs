//! 笔记命令

use super::err;
use crate::db::notes::{self, Note};
use crate::sync;

#[tauri::command]
pub fn list_notes(app: tauri::AppHandle) -> Result<Vec<Note>, String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    notes::list(&conn).map_err(err)
}

#[tauri::command]
pub fn create_note(app: tauri::AppHandle, title: String) -> Result<Note, String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    let note = notes::create(&conn, &title).map_err(err)?;
    drop(conn);
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(note)
}

#[tauri::command]
pub fn update_note(app: tauri::AppHandle, note: Note) -> Result<Note, String> {
    eprintln!(
        "[notes] update id={} title={} blocks_len={}",
        note.id,
        note.title,
        note.blocks.len()
    );
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    let updated = notes::update(&conn, &note).map_err(err)?;
    drop(conn);
    eprintln!(
        "[notes] updated id={} blocks_len={}",
        updated.id,
        updated.blocks.len()
    );
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(updated)
}

#[tauri::command]
pub fn delete_note(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    notes::delete(&conn, &id).map_err(err)?;
    drop(conn);
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(())
}

#[tauri::command]
pub fn toggle_pin_note(app: tauri::AppHandle, id: String) -> Result<Option<Note>, String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    let updated = notes::toggle_pin(&conn, &id).map_err(err)?;
    drop(conn);
    // 自动提交并推送（后台静默执行）
    sync::auto_commit(st);
    Ok(updated)
}
