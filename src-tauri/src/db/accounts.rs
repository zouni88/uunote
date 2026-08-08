//! 账号 CRUD（密码以密文存储，加解密在命令层完成）

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub title: String,
    pub username: String,
    /// 密码密文（base64：nonce||ciphertext）
    pub password_enc: String,
    pub url: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_account(row: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        title: row.get(1)?,
        username: row.get(2)?,
        password_enc: row.get(3)?,
        url: row.get(4)?,
        notes: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, username, password_enc, url, notes, created_at, updated_at
         FROM accounts ORDER BY updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_account)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[allow(dead_code)]
pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Account>> {
    let row = conn
        .query_row(
            "SELECT id, title, username, password_enc, url, notes, created_at, updated_at
             FROM accounts WHERE id = ?1",
            (id,),
            row_to_account,
        )
        .optional()?;
    Ok(row)
}

pub fn create(conn: &Connection, account: &Account) -> AppResult<Account> {
    let now = Utc::now().to_rfc3339();
    let acc = Account {
        id: Uuid::new_v4().to_string(),
        created_at: now.clone(),
        updated_at: now,
        ..account.clone()
    };
    conn.execute(
        "INSERT INTO accounts (id, title, username, password_enc, url, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (
            &acc.id, &acc.title, &acc.username, &acc.password_enc, &acc.url,
            &acc.notes, &acc.created_at, &acc.updated_at,
        ),
    )?;
    Ok(acc)
}

pub fn update(conn: &Connection, account: &Account) -> AppResult<Account> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE accounts SET title = ?1, username = ?2, password_enc = ?3, url = ?4,
         notes = ?5, updated_at = ?6 WHERE id = ?7",
        (
            &account.title, &account.username, &account.password_enc, &account.url,
            &account.notes, &now, &account.id,
        ),
    )?;
    let mut updated = account.clone();
    updated.updated_at = now;
    Ok(updated)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM accounts WHERE id = ?1", (id,))?;
    Ok(())
}
