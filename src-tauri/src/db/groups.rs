//! 笔记分组 CRUD
//!
//! 分组是 OneNote 式二级结构的顶层：分组 → 笔记。
//! 删除分组时，组内笔记回落到"未分组"（group_id 置空）。
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
pub struct NoteGroup {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_group(row: &rusqlite::Row) -> rusqlite::Result<NoteGroup> {
    Ok(NoteGroup {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

const COLUMNS: &str = "id, title, created_at, updated_at";

pub fn list(conn: &Connection) -> AppResult<Vec<NoteGroup>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM note_groups ORDER BY created_at ASC"
    ))?;
    let rows = stmt
        .query_map([], row_to_group)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<NoteGroup>> {
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM note_groups WHERE id = ?1"),
            (id,),
            row_to_group,
        )
        .optional()?;
    Ok(row)
}

pub fn create(conn: &Connection, title: &str) -> AppResult<NoteGroup> {
    let now = Utc::now().to_rfc3339();
    let group = NoteGroup {
        id: Uuid::new_v4().to_string(),
        title: title.trim().to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    let tx = conn.unchecked_transaction()?;
    let op = outbox::record(&tx, "group", "upsert", &group.id, &serde_json::to_string(&group)?)?;
    tx.execute(
        "INSERT INTO note_groups (id, title, created_at, updated_at, v_lamport, v_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (&group.id, &group.title, &group.created_at, &group.updated_at, op.lamport, &op.device_id),
    )?;
    tx.commit()?;
    Ok(group)
}

pub fn rename(conn: &Connection, id: &str, title: &str) -> AppResult<Option<NoteGroup>> {
    let Some(existing) = get(conn, id)? else {
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    let title = title.trim().to_string();
    let updated = NoteGroup {
        id: id.to_string(),
        title: title.clone(),
        created_at: existing.created_at.clone(),
        updated_at: now.clone(),
    };
    let tx = conn.unchecked_transaction()?;
    let op = outbox::record(&tx, "group", "upsert", id, &serde_json::to_string(&updated)?)?;
    tx.execute(
        "UPDATE note_groups SET title = ?1, updated_at = ?2, v_lamport = ?3, v_device = ?4 WHERE id = ?5",
        (&title, &now, op.lamport, &op.device_id, id),
    )?;
    tx.commit()?;
    Ok(Some(updated))
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    // 组内笔记回落到"未分组"：一并生成 note 操作，保证其他设备正确合并
    let affected: Vec<crate::db::notes::Note> = {
        let mut stmt = tx.prepare(
            "SELECT id, title, blocks, pinned, group_id, created_at, updated_at
             FROM notes WHERE group_id = ?1",
        )?;
        let rows = stmt
            .query_map((id,), |r| {
                Ok(crate::db::notes::Note {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    blocks: r.get(2)?,
                    pinned: r.get::<_, i64>(3)? != 0,
                    group_id: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for mut note in affected {
        note.group_id = None;
        let op = outbox::record(&tx, "note", "upsert", &note.id, &serde_json::to_string(&note)?)?;
        tx.execute(
            "UPDATE notes SET group_id = NULL, v_lamport = ?1, v_device = ?2 WHERE id = ?3",
            (op.lamport, &op.device_id, &note.id),
        )?;
    }
    outbox::record(&tx, "group", "delete", id, "")?;
    tx.execute("DELETE FROM note_groups WHERE id = ?1", (id,))?;
    tx.commit()?;
    Ok(())
}
