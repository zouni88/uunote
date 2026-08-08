//! 存储位置命令：查看 / 修改数据目录（数据库、vault、sync 所在位置）

use super::err;
use tauri::Manager;

#[tauri::command]
pub fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    let dir = st.data_dir.lock().unwrap().clone();
    Ok(dir.to_string_lossy().to_string())
}

/// 迁移数据到新目录（数据库、加密资料、同步仓库一并移动），
/// 迁移完成后立即生效，下次启动自动使用新位置。
#[tauri::command]
pub fn set_data_dir(app: tauri::AppHandle, new_dir: String) -> Result<String, String> {
    let st = super::state(&app);
    let default_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    st.set_data_dir(new_dir.trim().into(), &default_dir).map_err(err)
}
