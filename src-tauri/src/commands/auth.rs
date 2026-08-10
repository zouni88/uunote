//! 认证命令：设置主密码 / 解锁 / 锁定

use super::err;

#[tauri::command]
pub fn setup_master_password(app: tauri::AppHandle, password: String) -> Result<bool, String> {
    let st = super::state(&app);
    match st.setup_master_password(&password) {
        Ok(()) => Ok(true),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
pub fn unlock_app(app: tauri::AppHandle, password: String) -> Result<bool, String> {
    let st = super::state(&app);
    // 后台自动同步已在应用启动时开启（同步为明文，无需解锁）
    match st.unlock(&password) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn is_app_locked(app: tauri::AppHandle) -> Result<bool, String> {
    let st = super::state(&app);
    Ok(st.is_locked())
}

/// 是否已设置过主密码（用于区分「首次使用需设置」与「已设置需解锁」）
#[tauri::command]
pub fn has_master_password(app: tauri::AppHandle) -> Result<bool, String> {
    let st = super::state(&app);
    let conn = st.db.lock().unwrap();
    Ok(crate::db::meta::get(&conn, "salt").map_err(err)?.is_some())
}

#[tauri::command]
pub fn lock_app(app: tauri::AppHandle) -> Result<(), String> {
    let st = super::state(&app);
    st.lock();
    Ok(())
}

/// 修改主密码：验证旧密码后重加密全部敏感数据并更新解锁信息
#[tauri::command]
pub fn change_master_password(
    app: tauri::AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    let st = super::state(&app);
    st.change_master_password(&old_password, &new_password)
        .map_err(err)
}
