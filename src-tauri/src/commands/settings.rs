//! 应用偏好命令：主题模式（浅色 / 深色 / 跟随系统）
//!
//! 不校验主密钥：主题需在锁屏时也正确生效。

use super::err;
use crate::settings;

#[tauri::command]
pub fn get_theme(app: tauri::AppHandle) -> Result<String, String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    settings::get_theme(&conn).map_err(err)
}

#[tauri::command]
pub fn set_theme(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    settings::set_theme(&conn, &mode).map_err(err)
}
