//! meta 表：键值配置（盐、魔术串、同步配置、同步状态等）

use rusqlite::{Connection, OptionalExtension};

use crate::error::AppResult;

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )?;
    Ok(())
}

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let row = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", (key,), |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    Ok(row)
}
