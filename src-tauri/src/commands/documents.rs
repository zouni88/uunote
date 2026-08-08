//! 重要资料命令：导入（加密入库）/ 列表 / 删除 / 导出解密

use std::fs;
use std::path::Path;
use std::sync::Arc;

use tauri::async_runtime::spawn_blocking;

use super::err;
use crate::crypto;
use crate::db::documents::{self, Document};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::sync;

/// 简单根据扩展名推断 MIME
fn guess_mime(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "gif" => "image/gif".into(),
        "webp" => "image/webp".into(),
        "doc" => "application/msword".into(),
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
        "xls" => "application/vnd.ms-excel".into(),
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
        "ppt" | "pptx" => "application/vnd.ms-powerpoint".into(),
        "zip" => "application/zip".into(),
        "rar" => "application/vnd.rar".into(),
        "7z" => "application/x-7z-compressed".into(),
        "txt" | "md" => "text/plain".into(),
        "json" => "application/json".into(),
        _ => "application/octet-stream".into(),
    }
}

#[tauri::command]
pub fn list_documents(app: tauri::AppHandle) -> Result<Vec<Document>, String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    documents::list(&conn).map_err(err)
}

/// 导入：选择本地文件 → 加密存入 vault → 记录元数据（后台线程执行，避免卡 UI）
#[tauri::command]
pub async fn import_document(app: tauri::AppHandle, src_path: String) -> Result<Document, String> {
    let st = super::state(&app);
    spawn_blocking(move || import_document_sync(st, &src_path).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

fn import_document_sync(st: Arc<AppState>, src_path: &str) -> AppResult<Document> {
    let key = st.master_key()?;
    let vault_dir = st.vault_dir.lock().unwrap().clone();
    let src = Path::new(src_path);
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let title = Path::new(&file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&file_name)
        .to_string();
    let raw = fs::read(src)?;
    let size = raw.len() as i64;
    let encrypted = crypto::encrypt(&key, &raw)?;

    let enc_name = format!("{}.enc", uuid::Uuid::new_v4());
    fs::write(vault_dir.join(&enc_name), encrypted)?;

    let doc = Document {
        id: String::new(),
        title,
        file_name: file_name.clone(),
        file_path: enc_name,
        size,
        mime: guess_mime(&file_name),
        created_at: String::new(),
        updated_at: String::new(),
    };
    let conn = st.db.lock().unwrap();
    let created = documents::create(&conn, &doc)?;
    drop(conn);

    // 后台静默同步（失败不影响导入）
    sync::auto_commit(st);
    Ok(created)
}

#[tauri::command]
pub async fn delete_document(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let st = super::state(&app);
    spawn_blocking(move || delete_document_sync(st, &id).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_document_sync(st: Arc<AppState>, id: &str) -> AppResult<()> {
    st.master_key()?;
    // documents::delete 返回被删记录的 file_path（删除操作日志中已携带，供其他设备清理）
    let file_path = {
        let conn = st.db.lock().unwrap();
        documents::delete(&conn, id)?
    };
    if let Some(fp) = file_path {
        let _ = fs::remove_file(st.vault_dir.lock().unwrap().join(&fp));
    }
    // 后台静默同步（失败不影响删除）
    sync::auto_commit(st);
    Ok(())
}

/// 导出：解密后另存为用户选择的路径（后台线程执行）
#[tauri::command]
pub async fn export_document(app: tauri::AppHandle, id: String, dest_path: String) -> Result<(), String> {
    let st = super::state(&app);
    spawn_blocking(move || export_document_sync(&st, &id, &dest_path).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

fn export_document_sync(st: &crate::state::AppState, id: &str, dest_path: &str) -> AppResult<()> {
    let key = st.master_key()?;
    let conn = st.db.lock().unwrap();
    let doc = documents::get(&conn, id)?.ok_or_else(|| AppError::other("资料不存在"))?;
    drop(conn);

    let encrypted = fs::read(st.vault_dir.lock().unwrap().join(&doc.file_path))?;
    let plain = crypto::decrypt(&key, &encrypted)?;
    fs::write(Path::new(dest_path), plain)?;
    Ok(())
}
