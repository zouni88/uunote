//! 账号命令：前端传输明文密码，入库前用主密钥加密

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};

use super::err;
use crate::crypto;
use crate::db::accounts;
use crate::error::{AppError, AppResult};

/// 前端展示的账号（密码为明文）
#[derive(Debug, Clone, Serialize)]
pub struct AccountDto {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 前端提交的账号输入
#[derive(Debug, Clone, Deserialize)]
pub struct AccountInput {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
}

impl AccountInput {
    fn to_db(&self, key: &[u8; crypto::KEY_LEN]) -> AppResult<accounts::Account> {
        let password_enc = if self.password.is_empty() {
            String::new()
        } else {
            B64.encode(crypto::encrypt(key, self.password.as_bytes())?)
        };
        Ok(accounts::Account {
            id: self.id.clone(),
            title: self.title.clone(),
            username: self.username.clone(),
            password_enc,
            url: self.url.clone(),
            notes: self.notes.clone(),
            created_at: String::new(),
            updated_at: String::new(),
        })
    }
}

fn to_dto(acc: &accounts::Account, key: &[u8; crypto::KEY_LEN]) -> AppResult<AccountDto> {
    let password = if acc.password_enc.is_empty() {
        String::new()
    } else {
        let data = crypto::from_b64(&acc.password_enc)?;
        String::from_utf8(crypto::decrypt(key, &data)?)
            .map_err(|e| AppError::crypto(format!("密码解码失败: {e}")))?
    };
    Ok(AccountDto {
        id: acc.id.clone(),
        title: acc.title.clone(),
        username: acc.username.clone(),
        password,
        url: acc.url.clone(),
        notes: acc.notes.clone(),
        created_at: acc.created_at.clone(),
        updated_at: acc.updated_at.clone(),
    })
}

#[tauri::command]
pub fn list_accounts(app: tauri::AppHandle) -> Result<Vec<AccountDto>, String> {
    let st = super::state(&app);
    let key = st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    let rows = accounts::list(&conn).map_err(err)?;
    rows.iter().map(|a| to_dto(a, &key).map_err(err)).collect()
}

#[tauri::command]
pub fn create_account(app: tauri::AppHandle, account: AccountInput) -> Result<AccountDto, String> {
    let st = super::state(&app);
    let key = st.master_key().map_err(err)?;
    let db_acc = account.to_db(&key).map_err(err)?;
    let conn = st.db.lock().unwrap();
    let created = accounts::create(&conn, &db_acc).map_err(err)?;
    to_dto(&created, &key).map_err(err)
}

#[tauri::command]
pub fn update_account(app: tauri::AppHandle, account: AccountInput) -> Result<AccountDto, String> {
    let st = super::state(&app);
    let key = st.master_key().map_err(err)?;
    let db_acc = account.to_db(&key).map_err(err)?;
    let conn = st.db.lock().unwrap();
    let updated = accounts::update(&conn, &db_acc).map_err(err)?;
    to_dto(&updated, &key).map_err(err)
}

#[tauri::command]
pub fn delete_account(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let st = super::state(&app);
    st.master_key().map_err(err)?;
    let conn = st.db.lock().unwrap();
    accounts::delete(&conn, &id).map_err(err)
}
