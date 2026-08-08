//! Tauri 命令层：组织前端可调用的 #[tauri::command]，统一错误转字符串

pub mod accounts;
pub mod auth;
pub mod documents;
pub mod notes;
pub mod storage;
pub mod sync;

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::state::AppState;

/// 从应用句柄取全局状态（Arc 克隆，可安全移入异步任务）
pub fn state(app: &AppHandle) -> Arc<AppState> {
    app.state::<Arc<AppState>>().inner().clone()
}

/// AppError → 前端可见字符串
pub fn err(e: AppError) -> String {
    e.to_string()
}
