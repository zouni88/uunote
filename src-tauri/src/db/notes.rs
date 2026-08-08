//! 笔记 CRUD
//!
//! 每篇笔记是一张自由画布（OneNote 式）：
//! - blocks 存放画布场景 JSON（文字块/图片块/涂鸦路径，坐标自由摆放）
//!
//! 所有变更在同一事务内写入同步操作日志（sync_outbox），
//! 并更新记录行的版本（v_lamport/v_device）供跨设备合并。

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::outbox;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    /// 自由画布场景 JSON
    #[serde(default)]
    pub blocks: String,
    pub pinned: bool,
    /// 所属分组（OneNote 式二级结构），None 表示"未分组"
    #[serde(default)]
    pub group_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        blocks: row.get(2)?,
        pinned: row.get::<_, i64>(3)? != 0,
        group_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const COLUMNS: &str = "id, title, blocks, pinned, group_id, created_at, updated_at";

pub fn list(conn: &Connection) -> AppResult<Vec<Note>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM notes ORDER BY pinned DESC, updated_at DESC"
    ))?;
    let rows = stmt
        .query_map([], row_to_note)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[allow(dead_code)]
pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Note>> {
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM notes WHERE id = ?1"),
            (id,),
            row_to_note,
        )
        .optional()?;
    Ok(row)
}

pub fn create(conn: &Connection, title: &str, group_id: Option<String>) -> AppResult<Note> {
    let now = Utc::now().to_rfc3339();
    let note = Note {
        id: Uuid::new_v4().to_string(),
        title: title.trim().to_string(),
        blocks: String::new(),
        pinned: false,
        group_id,
        created_at: now.clone(),
        updated_at: now,
    };
    let tx = conn.unchecked_transaction()?;
    let op = outbox::record(&tx, "note", "upsert", &note.id, &serde_json::to_string(&note)?)?;
    tx.execute(
        "INSERT INTO notes (id, title, blocks, pinned, group_id, created_at, updated_at, v_lamport, v_device)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8)",
        (
            &note.id,
            &note.title,
            &note.blocks,
            &note.group_id,
            &note.created_at,
            &note.updated_at,
            op.lamport,
            &op.device_id,
        ),
    )?;
    tx.commit()?;
    Ok(note)
}

pub fn update(conn: &Connection, note: &Note) -> AppResult<Note> {
    let now = Utc::now().to_rfc3339();
    let mut updated = note.clone();
    updated.updated_at = now;
    let tx = conn.unchecked_transaction()?;
    let op = outbox::record(&tx, "note", "upsert", &note.id, &serde_json::to_string(&updated)?)?;
    tx.execute(
        "UPDATE notes SET title = ?1, blocks = ?2, pinned = ?3, group_id = ?4, updated_at = ?5,
         v_lamport = ?6, v_device = ?7 WHERE id = ?8",
        (
            &updated.title,
            &updated.blocks,
            updated.pinned as i64,
            &updated.group_id,
            &updated.updated_at,
            op.lamport,
            &op.device_id,
            &note.id,
        ),
    )?;
    tx.commit()?;
    Ok(updated)
}

pub fn toggle_pin(conn: &Connection, id: &str) -> AppResult<Option<Note>> {
    let Some(existing) = get(conn, id)? else {
        return Ok(None);
    };
    let mut updated = existing.clone();
    updated.pinned = !existing.pinned;
    updated.updated_at = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    let op = outbox::record(&tx, "note", "upsert", &id, &serde_json::to_string(&updated)?)?;
    tx.execute(
        "UPDATE notes SET pinned = ?1, updated_at = ?2, v_lamport = ?3, v_device = ?4 WHERE id = ?5",
        (updated.pinned as i64, &updated.updated_at, op.lamport, &op.device_id, id),
    )?;
    tx.commit()?;
    Ok(Some(updated))
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    outbox::record(&tx, "note", "delete", id, "")?;
    tx.execute("DELETE FROM notes WHERE id = ?1", (id,))?;
    tx.commit()?;
    Ok(())
}
