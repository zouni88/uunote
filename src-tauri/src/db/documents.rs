//! 重要资料 CRUD（元数据入库，加密文件本体存放于 vault 目录）

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub file_name: String,
    /// vault 目录内的加密文件名（相对）
    pub file_path: String,
    pub size: i64,
    pub mime: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_doc(row: &rusqlite::Row) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get(0)?,
        title: row.get(1)?,
        file_name: row.get(2)?,
        file_path: row.get(3)?,
        size: row.get(4)?,
        mime: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Document>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, file_name, file_path, size, mime, created_at, updated_at
         FROM documents ORDER BY updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_doc)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Document>> {
    let row = conn
        .query_row(
            "SELECT id, title, file_name, file_path, size, mime, created_at, updated_at
             FROM documents WHERE id = ?1",
            (id,),
            row_to_doc,
        )
        .optional()?;
    Ok(row)
}

pub fn create(conn: &Connection, doc: &Document) -> AppResult<Document> {
    let now = Utc::now().to_rfc3339();
    let doc = Document {
        id: Uuid::new_v4().to_string(),
        created_at: now.clone(),
        updated_at: now,
        ..doc.clone()
    };
    conn.execute(
        "INSERT INTO documents (id, title, file_name, file_path, size, mime, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (
            &doc.id, &doc.title, &doc.file_name, &doc.file_path,
            doc.size, &doc.mime, &doc.created_at, &doc.updated_at,
        ),
    )?;
    Ok(doc)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM documents WHERE id = ?1", (id,))?;
    Ok(())
}
