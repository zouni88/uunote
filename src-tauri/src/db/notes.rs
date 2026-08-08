//! 笔记 CRUD
//!
//! 每篇笔记是一张自由画布（OneNote 式）：
//! - blocks 存放画布场景 JSON（文字块/图片块/涂鸦路径，坐标自由摆放）

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        blocks: row.get(2)?,
        pinned: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const COLUMNS: &str = "id, title, blocks, pinned, created_at, updated_at";

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

pub fn create(conn: &Connection, title: &str) -> AppResult<Note> {
    let now = Utc::now().to_rfc3339();
    let note = Note {
        id: Uuid::new_v4().to_string(),
        title: title.trim().to_string(),
        blocks: String::new(),
        pinned: false,
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO notes (id, title, blocks, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5)",
        (
            &note.id,
            &note.title,
            &note.blocks,
            &note.created_at,
            &note.updated_at,
        ),
    )?;
    Ok(note)
}

pub fn update(conn: &Connection, note: &Note) -> AppResult<Note> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE notes SET title = ?1, blocks = ?2, pinned = ?3, updated_at = ?4 WHERE id = ?5",
        (
            &note.title,
            &note.blocks,
            note.pinned as i64,
            &now,
            &note.id,
        ),
    )?;
    let mut updated = note.clone();
    updated.updated_at = now;
    Ok(updated)
}

pub fn toggle_pin(conn: &Connection, id: &str) -> AppResult<Option<Note>> {
    let Some(existing) = get(conn, id)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE notes SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
        ((!existing.pinned) as i64, Utc::now().to_rfc3339(), id),
    )?;
    Ok(get(conn, id)?)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", (id,))?;
    Ok(())
}
