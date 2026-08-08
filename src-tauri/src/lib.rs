// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod crypto;
mod db;
mod error;
mod state;
mod sync;

use std::sync::Arc;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 应用数据目录：数据库、vault、同步仓库均存于此。
            // 用户可在设置中更改存储位置，此处读取指针文件解析最终目录。
            let data_dir = state::resolve_data_dir(&app.path().app_data_dir()?)?;
            let state = Arc::new(state::init(data_dir)?);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth::setup_master_password,
            commands::auth::unlock_app,
            commands::auth::is_app_locked,
            commands::auth::lock_app,
            commands::auth::change_master_password,
            commands::notes::list_notes,
            commands::notes::create_note,
            commands::notes::update_note,
            commands::notes::delete_note,
            commands::notes::toggle_pin_note,
            commands::accounts::list_accounts,
            commands::accounts::create_account,
            commands::accounts::update_account,
            commands::accounts::delete_account,
            commands::documents::list_documents,
            commands::documents::import_document,
            commands::documents::delete_document,
            commands::documents::export_document,
            commands::sync::get_sync_config,
            commands::sync::save_sync_config,
            commands::sync::sync_push,
            commands::sync::sync_pull,
            commands::sync::sync_auto,
            commands::storage::get_data_dir,
            commands::storage::set_data_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出时尝试自动推送未同步的本地数据（失败静默）
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app.try_state::<Arc<AppState>>() {
                    let st = st.inner().clone();
                    if !st.is_locked() && !st.repo_url.lock().unwrap().is_empty() {
                        let _ = sync::push(&st);
                    }
                }
            }
        });
}
