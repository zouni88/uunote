//! 同步操作日志（outbox）：记录本地每次数据变更，供增量同步推送
//!
//! - 每次增删改在同一事务内写入一条操作（含 Lamport 时钟 + 设备 ID）
//! - 同步推送成功后标记 pushed；压缩落快照后整体清空
//! - 跨设备合并采用「每记录 last-write-wins」：由记录行的 v_lamport/v_device
//!   与同步墓碑 sync_tombstones 共同决定远端操作是否生效（见 sync.rs）

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::meta;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOp {
    pub lamport: i64,
    pub device_id: String,
    /// 记录类型：note | group | account | document
    pub kind: String,
    /// 操作：upsert | delete
    pub op: String,
    pub record_id: String,
    /// upsert 时为记录 JSON；document 删除时为 {"filePath": "..."}，其余删除为空串
    #[serde(default)]
    pub data: String,
}

const LAMPORT_KEY: &str = "sync.lamport";
const DEVICE_KEY: &str = "sync.device_id";

/// 本机设备 ID（首次调用时生成并持久化）
pub fn device_id(conn: &Connection) -> AppResult<String> {
    if let Some(id) = meta::get(conn, DEVICE_KEY)? {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    meta::set(conn, DEVICE_KEY, &id)?;
    Ok(id)
}

/// Lamport 时钟：当前值 +1 并写回（须在事务内调用，保证同一事务内变更的时序）
pub fn next_lamport(conn: &Connection) -> AppResult<i64> {
    let cur = current_lamport(conn)?;
    let next = cur + 1;
    meta::set(conn, LAMPORT_KEY, &next.to_string())?;
    Ok(next)
}

/// 当前 Lamport 值（未推进）
pub fn current_lamport(conn: &Connection) -> AppResult<i64> {
    Ok(meta::get(conn, LAMPORT_KEY)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0))
}

/// 把本地时钟推进到至少 max_lp（拉取远端操作后调用，保证后续本地操作时序更大）
pub fn bump_lamport(conn: &Connection, max_lp: i64) -> AppResult<()> {
    if max_lp > current_lamport(conn)? {
        meta::set(conn, LAMPORT_KEY, &max_lp.to_string())?;
    }
    Ok(())
}

/// 记录一条本地操作（未推送），返回生成的操作（含 lamport / device_id）
pub fn record(
    conn: &Connection,
    kind: &str,
    op: &str,
    record_id: &str,
    data: &str,
) -> AppResult<SyncOp> {
    let device = device_id(conn)?;
    let lamport = next_lamport(conn)?;
    conn.execute(
        "INSERT INTO sync_outbox (lamport, device_id, kind, op, record_id, data, pushed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        (lamport, &device, kind, op, record_id, data),
    )?;
    Ok(SyncOp {
        lamport,
        device_id: device,
        kind: kind.to_string(),
        op: op.to_string(),
        record_id: record_id.to_string(),
        data: data.to_string(),
    })
}

/// 未推送的操作（按产生顺序返回 id + op）
pub fn pending(conn: &Connection) -> AppResult<Vec<(i64, SyncOp)>> {
    let mut stmt = conn.prepare(
        "SELECT id, lamport, device_id, kind, op, record_id, data
         FROM sync_outbox WHERE pushed = 0 ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                SyncOp {
                    lamport: r.get(1)?,
                    device_id: r.get(2)?,
                    kind: r.get(3)?,
                    op: r.get(4)?,
                    record_id: r.get(5)?,
                    data: r.get(6)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn mark_pushed(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    for id in ids {
        conn.execute("UPDATE sync_outbox SET pushed = 1 WHERE id = ?1", (id,))?;
    }
    Ok(())
}

/// 压缩落快照后调用：日志已全部体现在快照中，整体清空
pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM sync_outbox", [])?;
    Ok(())
}

/// outbox 中的最大 Lamport（压缩写快照版本号用）
pub fn max_lamport(conn: &Connection) -> AppResult<i64> {
    let row: Option<i64> = conn
        .query_row("SELECT COALESCE(MAX(lamport), 0) FROM sync_outbox", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(row.unwrap_or(0))
}

// ---------- 墓碑 ----------

/// 读取墓碑版本；无墓碑返回 None
pub fn tombstone(conn: &Connection, kind: &str, record_id: &str) -> AppResult<Option<(i64, String)>> {
    let row = conn
        .query_row(
            "SELECT lamport, device_id FROM sync_tombstones WHERE kind = ?1 AND record_id = ?2",
            (kind, record_id),
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(row)
}

pub fn set_tombstone(conn: &Connection, kind: &str, record_id: &str, lamport: i64, device_id: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_tombstones (kind, record_id, lamport, device_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, record_id) DO UPDATE SET lamport = excluded.lamport, device_id = excluded.device_id",
        (kind, record_id, lamport, device_id),
    )?;
    Ok(())
}

pub fn remove_tombstone(conn: &Connection, kind: &str, record_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_tombstones WHERE kind = ?1 AND record_id = ?2",
        (kind, record_id),
    )?;
    Ok(())
}

/// 清空全部墓碑（快照导入后调用：快照已代表合并后的当前状态）
pub fn clear_tombstones(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM sync_tombstones", [])?;
    Ok(())
}

/// 记录行上的版本（v_lamport/v_device）；无记录返回 (0, "")
pub fn row_version(conn: &Connection, table: &str, record_id: &str) -> AppResult<(i64, String)> {
    let sql = format!(
        "SELECT v_lamport, v_device FROM {table} WHERE id = ?1"
    );
    let row = conn
        .query_row(&sql, (record_id,), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?;
    Ok(row.unwrap_or((0, String::new())))
}

/// 版本比较：(lamport, device_id) 全局字典序（device 仅作并列平局裁决）
pub fn op_is_newer(op_lamport: i64, op_device: &str, cur_lamport: i64, cur_device: &str) -> bool {
    op_lamport > cur_lamport
        || (op_lamport == cur_lamport && op_device > cur_device)
}
