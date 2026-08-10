//! 本地 SQLite 数据库：连接管理、建表与通用辅助

pub mod accounts;
pub mod documents;
pub mod groups;
pub mod meta;
pub mod notes;
pub mod outbox;

use std::path::Path;

use rusqlite::Connection;
use rusqlite::OpenFlags;

use crate::error::AppResult;

/// 打开数据库并初始化表结构
pub fn open(db_path: &Path) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notes (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            mode       TEXT NOT NULL DEFAULT 'freeform',
            content    TEXT NOT NULL DEFAULT '',
            pinned     INTEGER NOT NULL DEFAULT 0,
            group_id   TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            v_lamport  INTEGER NOT NULL DEFAULT 0,
            v_device   TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS note_groups (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            v_lamport  INTEGER NOT NULL DEFAULT 0,
            v_device   TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id            TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            username      TEXT NOT NULL DEFAULT '',
            password_enc  TEXT NOT NULL DEFAULT '',
            url           TEXT NOT NULL DEFAULT '',
            notes         TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            v_lamport     INTEGER NOT NULL DEFAULT 0,
            v_device      TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS documents (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            file_name  TEXT NOT NULL,
            file_path  TEXT NOT NULL,
            size       INTEGER NOT NULL DEFAULT 0,
            mime       TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            v_lamport  INTEGER NOT NULL DEFAULT 0,
            v_device   TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- 同步操作日志（outbox）：本地每次变更写入一条，推送后标记 pushed
        CREATE TABLE IF NOT EXISTS sync_outbox (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            lamport    INTEGER NOT NULL,
            device_id  TEXT NOT NULL,
            kind       TEXT NOT NULL,
            op         TEXT NOT NULL,
            record_id  TEXT NOT NULL,
            data       TEXT NOT NULL DEFAULT '',
            pushed     INTEGER NOT NULL DEFAULT 0
        );

        -- 同步墓碑：删除操作的版本记录，防止旧操作把已删除的记录复活
        CREATE TABLE IF NOT EXISTS sync_tombstones (
            kind       TEXT NOT NULL,
            record_id  TEXT NOT NULL,
            lamport    INTEGER NOT NULL,
            device_id  TEXT NOT NULL,
            PRIMARY KEY (kind, record_id)
        );
        "#,
    )?;
    migrate(conn)?;
    Ok(())
}

/// 老库升级：旧版笔记为多内容列结构，统一收敛为「mode + content」单列结构：
///   - 三列版（blocks/markdown/rich_text）：按 mode 取对应列内容，其余列合并进 content
///   - 更早的双列版（content/canvas_elements/note_type）：内容已废弃，仅保留标题等元数据（与历史行为一致）
fn migrate(conn: &Connection) -> AppResult<()> {
    let has_col = |table: &str, name: &str| -> bool {
        let cols: Vec<String> = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
                rows.collect()
            })
            .unwrap_or_default();
        cols.iter().any(|c| c == name)
    };
    if has_col("notes", "blocks") || has_col("notes", "markdown") || has_col("notes", "rich_text") {
        // 三列版 → 单一 content：按 mode 归并内容
        conn.execute_batch(
            "ALTER TABLE notes RENAME TO notes_old;
             CREATE TABLE notes (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                mode       TEXT NOT NULL DEFAULT 'freeform',
                content    TEXT NOT NULL DEFAULT '',
                pinned     INTEGER NOT NULL DEFAULT 0,
                group_id   TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                v_lamport  INTEGER NOT NULL DEFAULT 0,
                v_device   TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO notes (id, title, mode, content, pinned, group_id, created_at, updated_at, v_lamport, v_device)
                SELECT id, title, mode,
                       CASE WHEN mode = 'markdown' THEN markdown
                            WHEN mode = 'richtext' THEN rich_text
                            ELSE blocks END,
                       pinned, group_id, created_at, updated_at, v_lamport, v_device
                FROM notes_old;
             DROP TABLE notes_old;",
        )?;
    } else if has_col("notes", "canvas_elements")
        || has_col("notes", "note_type")
        || (has_col("notes", "content") && !has_col("notes", "mode"))
    {
        // 更早的双列版（有 content/canvas_elements，无 mode）：内容废弃不迁移，仅保留标题等元数据。
        // 注意：新库同样含 content 列，必须用「无 mode 列」区分，否则每次启动都会误判重建清空数据。
        conn.execute_batch(
            "ALTER TABLE notes RENAME TO notes_old;
             CREATE TABLE notes (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                mode       TEXT NOT NULL DEFAULT 'freeform',
                content    TEXT NOT NULL DEFAULT '',
                pinned     INTEGER NOT NULL DEFAULT 0,
                group_id   TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                v_lamport  INTEGER NOT NULL DEFAULT 0,
                v_device   TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO notes (id, title, pinned, created_at, updated_at)
                SELECT id, title, pinned, created_at, updated_at FROM notes_old;
             DROP TABLE notes_old;",
        )?;
    }
    // 二级分组结构：为老库补充 notes.group_id 列（新库建表时已包含）
    if !has_col("notes", "group_id") {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN group_id TEXT")?;
    }
    // 增量同步版本列：为老库补充 v_lamport / v_device（新库建表时已包含）
    for (table, cols) in [
        ("notes", ["v_lamport", "v_device"]),
        ("note_groups", ["v_lamport", "v_device"]),
        ("accounts", ["v_lamport", "v_device"]),
        ("documents", ["v_lamport", "v_device"]),
    ] {
        for col in cols {
            if !has_col(table, col) {
                let ty = if col == "v_lamport" {
                    "INTEGER NOT NULL DEFAULT 0"
                } else {
                    "TEXT NOT NULL DEFAULT ''"
                };
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {ty}"))?;
            }
        }
    }
    Ok(())
}
