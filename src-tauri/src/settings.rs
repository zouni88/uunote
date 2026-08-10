//! 应用偏好设置：目前仅主题模式（浅色 / 深色 / 跟随系统），存于 meta 表。
//! 与主密码无关，锁屏界面也需要在解锁前就正确渲染主题。

use rusqlite::Connection;

use crate::db::meta;
use crate::error::{AppError, AppResult};

/// 主题偏好键
const THEME_KEY: &str = "app.theme";
/// 默认跟随系统
const DEFAULT_THEME: &str = "system";

pub fn get_theme(conn: &Connection) -> AppResult<String> {
    Ok(meta::get(conn, THEME_KEY)?.unwrap_or_else(|| DEFAULT_THEME.into()))
}

pub fn set_theme(conn: &Connection, mode: &str) -> AppResult<()> {
    if !matches!(mode, "light" | "dark" | "system") {
        return Err(AppError::other("无效的主题模式"));
    }
    meta::set(conn, THEME_KEY, mode)?;
    Ok(())
}
