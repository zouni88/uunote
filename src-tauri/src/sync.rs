//! GitHub 云同步：内嵌 git2 推送/拉取增量操作日志，Token 存 Windows 凭据管理器
//!
//! 同步内容 = 一份「增量操作日志」（ops/*.op，每条操作含 Lamport 时钟 + 设备 ID，
//! 跨设备按 (lamport, device_id) 全局排序回放，每记录 last-write-wins 自动合并，
//! 删除以墓碑形式传播，不会互相覆盖或复活）+ vault 目录中的资料文件本体。
//!
//! 同步文件为明文（仅账号密码字段在记录内单独加密），无需主密钥即可同步，
//! 因此应用启动即自动同步，解锁仅用于查看账号密码。
//!
//! 快照（snapshot.v + notes/*.json 等）仅用于「压缩」：ops 过多时把合并后的当前状态
//! 落成快照并清空日志，避免日志无限增长。

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository, ResetType};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::{accounts, documents, groups, meta, notes, outbox};
use crate::db::outbox::SyncOp;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, SyncStatus};

pub const KEYRING_SERVICE: &str = "com.zouni.uunote";
pub const KEYRING_TOKEN_USER: &str = "github_token";

/// 旧版整体快照文件名（不再导入，仅用于识别清理旧数据）
const SNAPSHOT_FILE: &str = "snapshot.enc";
/// 快照版本文件：压缩时写入当时的最大 Lamport，导入时作为合并基线
const SNAPSHOT_VERSION_FILE: &str = "snapshot.v";
const VAULT_SUBDIR: &str = "vault";
const OPS_SUBDIR: &str = "ops";
/// ops 文件达到该数量后触发压缩（落快照 + 清空日志）
const COMPACT_THRESHOLD: usize = 200;
/// 单个 .op 文件最多打包的操作数
const OP_BATCH_SIZE: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub repo_url: String,
    pub branch: String,
    /// Git 代理地址（可选，如 http://127.0.0.1:7890）
    pub git_proxy: Option<String>,
    pub last_sync_at: Option<String>,
    /// Token 是否已保存到系统凭据管理器（不回显明文）
    pub has_token: bool,
    /// 自动同步开关
    pub auto_sync: bool,
}

// ---------- Token / 配置 ----------

pub fn set_token(token: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_TOKEN_USER)?;
    entry.set_password(token)?;
    Ok(())
}

pub fn get_token() -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_TOKEN_USER)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save_config(
    conn: &Connection,
    repo_url: &str,
    branch: &str,
    token: &str,
    git_proxy: &str,
) -> AppResult<()> {
    let repo_url = repo_url.trim().trim_end_matches('/').to_string();
    if repo_url.is_empty() {
        return Err(AppError::other("仓库地址不能为空"));
    }
    let branch = if branch.trim().is_empty() { "main" } else { branch.trim() };
    let git_proxy = git_proxy.trim();
    if !token.is_empty() {
        set_token(token)?;
    }
    meta::set(conn, "sync.repo_url", &repo_url)?;
    meta::set(conn, "sync.branch", branch)?;
    meta::set(conn, "sync.git_proxy", git_proxy)?;
    Ok(())
}

pub fn get_config(conn: &Connection) -> AppResult<Option<SyncConfig>> {
    let Some(repo_url) = meta::get(conn, "sync.repo_url")? else {
        return Ok(None);
    };
    let branch = meta::get(conn, "sync.branch")?.unwrap_or_else(|| "main".into());
    let git_proxy = meta::get(conn, "sync.git_proxy")?;
    let last_sync_at = meta::get(conn, "sync.last_sync_at")?;
    let auto_sync = meta::get(conn, "sync.auto")?
        .map(|v| v != "false")
        .unwrap_or(true);
    let has_token = get_token()?.is_some();
    Ok(Some(SyncConfig {
        repo_url,
        branch,
        git_proxy,
        last_sync_at,
        has_token,
        auto_sync,
    }))
}

/// 构造代理选项：传入最终生效的代理地址，为空则交给 libgit2 自动检测
/// （读取 git 配置 http.proxy 或 http_proxy/https_proxy 环境变量）
fn proxy_options(proxy: &str) -> git2::ProxyOptions<'static> {
    let mut opts = git2::ProxyOptions::new();
    let proxy = proxy.trim();
    if proxy.is_empty() {
        opts.auto();
    } else {
        opts.url(proxy);
    }
    opts
}

/// 最终生效的代理：手动配置 > Windows 系统代理 > 空（走环境变量自动检测）
fn effective_proxy(configured: &str) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    #[cfg(windows)]
    if let Some(proxy) = windows_system_proxy() {
        return proxy;
    }
    String::new()
}

/// 读取 Windows 系统代理（Internet Options 注册表），如 Clash「系统代理」模式设置的值
#[cfg(windows)]
fn windows_system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const SETTINGS_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu.open_subkey(SETTINGS_KEY).ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    if enabled != 1 {
        return None;
    }
    let server: String = settings.get_value("ProxyServer").ok()?;
    normalize_proxy_server(&server)
}

/// 规范化注册表中的代理地址，如 "127.0.0.1:7890" 或 "http=...;https=127.0.0.1:7890"
#[cfg(windows)]
fn normalize_proxy_server(server: &str) -> Option<String> {
    let s = server.trim();
    if s.is_empty() {
        return None;
    }
    // 形如 "http=127.0.0.1:7890;https=127.0.0.1:7890"：优先取 https 段
    if s.contains('=') {
        let mut https_part = None;
        for part in s.split(';') {
            if let Some((scheme, addr)) = part.trim().split_once('=') {
                if scheme.trim().eq_ignore_ascii_case("https") {
                    https_part = Some(addr.trim());
                    break;
                }
            }
        }
        let addr = https_part.or_else(|| {
            s.split(';')
                .next()
                .and_then(|p| p.trim().split_once('='))
                .map(|(_, a)| a.trim())
        })?;
        return Some(format!("http://{addr}"));
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        Some(s.to_string())
    } else {
        Some(format!("http://{s}"))
    }
}

// ---------- Git 仓库操作 ----------

fn open_or_clone_repo(state: &AppState, token: &str) -> AppResult<Repository> {
    let repo_dir = state.sync_dir.lock().unwrap().clone();
    fs::create_dir_all(&repo_dir)?;
    let git_dir = repo_dir.join(".git");
    // 残留的半成品仓库（缺少 refs/objects）视为损坏，清理后重新克隆
    if git_dir.exists()
        && (!git_dir.join("refs").exists() || !git_dir.join("objects").exists())
    {
        let _ = fs::remove_dir_all(&repo_dir);
    }
    if let Ok(repo) = Repository::open(&repo_dir) {
        return Ok(repo);
    }
    // 无可用仓库：清空目录后尝试克隆
    let _ = fs::remove_dir_all(&repo_dir);
    fs::create_dir_all(&repo_dir)?;

    let proxy = effective_proxy(&state.git_proxy.lock().unwrap());
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(credentials_cb(token));
    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);
    fetch_opts.proxy_options(proxy_options(&proxy));
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch_opts);
    let repo_url = state.repo_url.lock().unwrap().clone();

    match builder.clone(&repo_url, &repo_dir) {
        Ok(repo) => Ok(repo),
        Err(e) => {
            // 克隆失败：清空残留目录
            let _ = fs::remove_dir_all(&repo_dir);
            fs::create_dir_all(&repo_dir)?;
            // 远端是空仓库（尚无任何提交）时无法克隆：
            // 本地初始化空仓库并设置 origin，等用户「推送」完成首次同步
            if remote_is_empty(&proxy, token, &repo_url) {
                let repo = Repository::init(&repo_dir)?;
                repo.remote("origin", &repo_url)?;
                // 让 HEAD 指向配置的分支，确保首次推送使用正确的分支名
                let branch = state.branch.lock().unwrap().clone();
                let _ = repo.set_head(&format!("refs/heads/{branch}"));
                Ok(repo)
            } else {
                Err(AppError::sync(format!("克隆仓库失败: {e}")))
            }
        }
    }
}

/// 探测远端仓库是否为空（无任何引用）。仅用于克隆失败时
/// 区分「远端空仓库（应本地初始化）」与「真实网络/权限错误（应报错）」。
fn remote_is_empty(proxy: &str, token: &str, url: &str) -> bool {
    use git2::Direction;

    let probe_dir =
        std::env::temp_dir().join(format!("uunote-probe-{}", uuid::Uuid::new_v4()));
    let empty: std::result::Result<bool, git2::Error> = (|| {
        let repo = Repository::init(&probe_dir)?;
        repo.remote("origin", url)?;
        let mut remote = repo.find_remote("origin")?;
        let mut callbacks = RemoteCallbacks::new();
        callbacks.credentials(credentials_cb(token));
        remote.connect_auth(Direction::Fetch, Some(callbacks), Some(proxy_options(proxy)))?;
        let refs = remote.list()?;
        Ok(refs.is_empty())
    })();
    let _ = fs::remove_dir_all(&probe_dir);
    empty.unwrap_or(false)
}

fn credentials_cb(token: &str) -> impl FnMut(&str, Option<&str>, CredentialType) -> Result<Cred, git2::Error> + '_ {
    let token = token.to_string();
    move |_url, _username, _allowed| {
        if _allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            Cred::userpass_plaintext("x-oauth-basic", &token)
        } else if _allowed.contains(CredentialType::DEFAULT) {
            Cred::default()
        } else {
            Err(git2::Error::from_str("不支持的认证方式"))
        }
    }
}

fn remote_callbacks(token: &str) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    let token = token.to_string();
    cb.credentials(move |_url, _username, allowed| {
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            Cred::userpass_plaintext("x-oauth-basic", &token)
        } else {
            Err(git2::Error::from_str("不支持的认证方式"))
        }
    });
    cb
}

#[allow(dead_code)]
/// 检查本地是否有未提交的变更（保留：供后续冲突/脏检测使用）
fn working_tree_clean(repo: &Repository) -> bool {
    repo.statuses(None).map(|s| s.is_empty()).unwrap_or(false)
}

// ---------- 增量操作日志（ops/*.op） ----------

fn ops_dir(sync_dir: &std::path::Path) -> PathBuf {
    sync_dir.join(OPS_SUBDIR)
}

/// 把一批操作写入一个新 .op 文件（明文 JSON）。
/// 文件名取首操作的 lamport-设备前缀，跨设备全局唯一（lamport 每设备单调递增）。
fn write_op_batch(sync_dir: &std::path::Path, ops: &[SyncOp]) -> AppResult<String> {
    if ops.is_empty() {
        return Ok(String::new());
    }
    let dir = ops_dir(sync_dir);
    fs::create_dir_all(&dir)?;
    let first = &ops[0];
    let name = format!(
        "{}-{}.op",
        first.lamport,
        &first.device_id[..first.device_id.len().min(8)]
    );
    let json = serde_json::to_vec(ops)?;
    fs::write(dir.join(&name), json)?;
    Ok(name)
}

/// 读取 ops/ 目录下全部操作并按 (lamport, device_id) 全局排序。
/// 旧版加密 .op 文件无法解析为 JSON，视为残留数据直接清理（本地数据为准）。
fn read_all_ops(sync_dir: &std::path::Path) -> AppResult<Vec<SyncOp>> {
    let dir = ops_dir(sync_dir);
    let mut ops = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("op") {
                continue;
            }
            let json = match fs::read(&path) {
                Ok(j) => j,
                Err(_) => continue,
            };
            match serde_json::from_slice::<Vec<SyncOp>>(&json) {
                Ok(batch) => ops.extend(batch),
                Err(_) => {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    ops.sort_by(|a, b| (a.lamport, &a.device_id).cmp(&(b.lamport, &b.device_id)));
    Ok(ops)
}

fn count_op_files(sync_dir: &std::path::Path) -> usize {
    ops_dir(sync_dir)
        .read_dir()
        .map(|d| {
            d.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("op"))
                .count()
        })
        .unwrap_or(0)
}

// ---------- 远端操作应用（合并） ----------

/// 应用一条远端操作到本地数据库。
/// 采用「每记录 last-write-wins」+ 墓碑 + 快照基线：
///   - 快照基线：所有 <= 基线的操作已体现在快照中，直接忽略（防止旧操作复活已删记录）
///   - 行版本 + 墓碑：操作须比当前行版本和墓碑都新才会生效
fn apply_op(
    conn: &Connection,
    op: &SyncOp,
    vault_dir: &std::path::Path,
    sync_dir: &std::path::Path,
) -> AppResult<bool> {
    let baseline = meta::get(conn, "sync.baseline")?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if op.lamport <= baseline {
        return Ok(false);
    }
    let op_device = &op.device_id;
    let newer_than = |cur_lp: i64, cur_dev: &str| {
        outbox::op_is_newer(op.lamport, op_device, cur_lp, cur_dev)
    };
    match op.kind.as_str() {
        "note" => {
            let cur = outbox::row_version(conn, "notes", &op.record_id)?;
            let tomb = outbox::tombstone(conn, "note", &op.record_id)?.unwrap_or((0, String::new()));
            if !newer_than(cur.0, &cur.1) || !newer_than(tomb.0, &tomb.1) {
                return Ok(false);
            }
            if op.op == "delete" {
                conn.execute("DELETE FROM notes WHERE id = ?1", (&op.record_id,))?;
                outbox::set_tombstone(conn, "note", &op.record_id, op.lamport, op_device)?;
            } else {
                let note: notes::Note = serde_json::from_str(&op.data)?;
                conn.execute(
                    "INSERT INTO notes (id, title, mode, content, pinned, group_id, created_at, updated_at, v_lamport, v_device)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET title = excluded.title, mode = excluded.mode,
                        content = excluded.content, pinned = excluded.pinned, group_id = excluded.group_id,
                        updated_at = excluded.updated_at,
                        v_lamport = excluded.v_lamport, v_device = excluded.v_device",
                    (&note.id, &note.title, &note.mode, &note.content,
                     note.pinned as i64, &note.group_id,
                     &note.created_at, &note.updated_at, op.lamport, op_device),
                )?;
                outbox::remove_tombstone(conn, "note", &op.record_id)?;
            }
        }
        "group" => {
            let cur = outbox::row_version(conn, "note_groups", &op.record_id)?;
            let tomb = outbox::tombstone(conn, "group", &op.record_id)?.unwrap_or((0, String::new()));
            if !newer_than(cur.0, &cur.1) || !newer_than(tomb.0, &tomb.1) {
                return Ok(false);
            }
            if op.op == "delete" {
                conn.execute("DELETE FROM note_groups WHERE id = ?1", (&op.record_id,))?;
                outbox::set_tombstone(conn, "group", &op.record_id, op.lamport, op_device)?;
            } else {
                let g: groups::NoteGroup = serde_json::from_str(&op.data)?;
                conn.execute(
                    "INSERT INTO note_groups (id, title, created_at, updated_at, v_lamport, v_device)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
                        v_lamport = excluded.v_lamport, v_device = excluded.v_device",
                    (&g.id, &g.title, &g.created_at, &g.updated_at, op.lamport, op_device),
                )?;
                outbox::remove_tombstone(conn, "group", &op.record_id)?;
            }
        }
        "account" => {
            let cur = outbox::row_version(conn, "accounts", &op.record_id)?;
            let tomb = outbox::tombstone(conn, "account", &op.record_id)?.unwrap_or((0, String::new()));
            if !newer_than(cur.0, &cur.1) || !newer_than(tomb.0, &tomb.1) {
                return Ok(false);
            }
            if op.op == "delete" {
                conn.execute("DELETE FROM accounts WHERE id = ?1", (&op.record_id,))?;
                outbox::set_tombstone(conn, "account", &op.record_id, op.lamport, op_device)?;
            } else {
                let a: accounts::Account = serde_json::from_str(&op.data)?;
                conn.execute(
                    "INSERT INTO accounts (id, title, username, password_enc, url, notes, created_at, updated_at, v_lamport, v_device)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET title = excluded.title, username = excluded.username,
                        password_enc = excluded.password_enc, url = excluded.url, notes = excluded.notes,
                        updated_at = excluded.updated_at,
                        v_lamport = excluded.v_lamport, v_device = excluded.v_device",
                    (&a.id, &a.title, &a.username, &a.password_enc, &a.url, &a.notes,
                     &a.created_at, &a.updated_at, op.lamport, op_device),
                )?;
                outbox::remove_tombstone(conn, "account", &op.record_id)?;
            }
        }
        "document" => {
            let cur = outbox::row_version(conn, "documents", &op.record_id)?;
            let tomb = outbox::tombstone(conn, "document", &op.record_id)?.unwrap_or((0, String::new()));
            if !newer_than(cur.0, &cur.1) || !newer_than(tomb.0, &tomb.1) {
                return Ok(false);
            }
            if op.op == "delete" {
                conn.execute("DELETE FROM documents WHERE id = ?1", (&op.record_id,))?;
                // 删除操作 data 携带 {"filePath": "..."}，清理本地 vault 文件本体
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&op.data) {
                    if let Some(fp) = payload.get("filePath").and_then(|v| v.as_str()) {
                        let _ = fs::remove_file(vault_dir.join(fp));
                    }
                }
                outbox::set_tombstone(conn, "document", &op.record_id, op.lamport, op_device)?;
            } else {
                let doc: documents::Document = serde_json::from_str(&op.data)?;
                conn.execute(
                    "INSERT INTO documents (id, title, file_name, file_path, size, mime, created_at, updated_at, v_lamport, v_device)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET title = excluded.title, file_name = excluded.file_name,
                        file_path = excluded.file_path, size = excluded.size, mime = excluded.mime,
                        updated_at = excluded.updated_at,
                        v_lamport = excluded.v_lamport, v_device = excluded.v_device",
                    (&doc.id, &doc.title, &doc.file_name, &doc.file_path, doc.size, &doc.mime,
                     &doc.created_at, &doc.updated_at, op.lamport, op_device),
                )?;
                // 恢复资料文件本体（仅缺失时复制，blob 内容按 file_path 不可变）
                let src = sync_dir.join(VAULT_SUBDIR).join(&doc.file_path);
                if src.exists() {
                    let dst = vault_dir.join(&doc.file_path);
                    if !dst.exists() {
                        fs::create_dir_all(dst.parent().unwrap_or(vault_dir))?;
                        fs::copy(&src, &dst)?;
                    }
                }
                outbox::remove_tombstone(conn, "document", &op.record_id)?;
            }
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// 合并远端数据到本地（拉取 / 推送前都会调用）：
/// 有 ops/ → 回放增量；否则有快照 → 导入快照（含基线）。
/// 返回是否应用了任何远端变更（供前端刷新与状态提示）。
fn merge_remote(state: &AppState) -> AppResult<usize> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();

    if count_op_files(&sync_dir) > 0 {
        let ops = read_all_ops(&sync_dir)?;
        if ops.is_empty() {
            return Ok(0);
        }
        let mut applied = 0usize;
        {
            let conn = state.db.lock().unwrap();
            let tx = conn.unchecked_transaction()?;
            for op in &ops {
                if apply_op(&tx, op, &vault_dir, &sync_dir)? {
                    applied += 1;
                }
            }
            let max_lp = ops.iter().map(|o| o.lamport).max().unwrap_or(0);
            outbox::bump_lamport(&tx, max_lp)?;
            tx.commit()?;
        }
        if applied > 0 {
            emit_changed(state);
        }
        return Ok(applied);
    }

    let has_snapshot = sync_dir.join("notes").exists()
        || sync_dir.join("accounts").exists()
        || sync_dir.join("documents").exists()
        || sync_dir.join(SNAPSHOT_VERSION_FILE).exists();
    if has_snapshot {
        import_snapshot(state)?;
        emit_changed(state);
        return Ok(1);
    }

    // 旧版整体加密快照（snapshot.enc）：无法解密，清理掉（本地数据为准）
    let enc_path = sync_dir.join(SNAPSHOT_FILE);
    if enc_path.exists() {
        let _ = fs::remove_file(&enc_path);
    }
    Ok(0)
}

/// 通知前端数据已变化（远端合并后各页面应重新拉取）
fn emit_changed(state: &AppState) {
    use tauri::Emitter;
    let app = state.app_handle.lock().unwrap().clone();
    if let Some(app) = app {
        let _ = app.emit("sync://changed", ());
    }
}

/// 更新内存与前端同步状态
pub fn emit_status(state: &AppState, status: &str, message: impl Into<String>) {
    let message = message.into();
    *state.sync_status.lock().unwrap() = SyncStatus {
        state: status.to_string(),
        message: message.clone(),
    };
    use tauri::Emitter;
    let app = state.app_handle.lock().unwrap().clone();
    if let Some(app) = app {
        let _ = app.emit("sync://status", SyncStatus {
            state: status.to_string(),
            message,
        });
    }
}

// ---------- 快照（压缩 / 导入） ----------

/// 把一批记录各写成一个明文 JSON 文件，并清理已删除记录的残留文件
fn write_records<T: Serialize>(
    sync_dir: &std::path::Path,
    subdir: &str,
    items: &[T],
    id_of: impl Fn(&T) -> &str,
) -> AppResult<()> {
    let dir = sync_dir.join(subdir);
    fs::create_dir_all(&dir)?;
    let alive: std::collections::HashSet<String> =
        items.iter().map(|i| id_of(i).to_string()).collect();
    for item in items {
        let json = serde_json::to_vec_pretty(item)?;
        fs::write(dir.join(format!("{}.json", id_of(item))), json)?;
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(id) = name.strip_suffix(".json") {
            if !alive.contains(id) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// 读取某个子目录下的全部记录文件。
/// 旧版加密记录无法解析为 JSON 时直接清理，并通过返回值标记「有过无法解析的残留文件」
/// （调用方据此跳过导入，避免用空数据清空本地数据库）。
fn read_records<T: serde::de::DeserializeOwned>(
    sync_dir: &std::path::Path,
    subdir: &str,
) -> AppResult<(Vec<T>, bool)> {
    let dir = sync_dir.join(subdir);
    let mut items = Vec::new();
    let mut cleaned = false;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let json = match fs::read(&path) {
                Ok(j) => j,
                Err(_) => continue,
            };
            match serde_json::from_slice::<T>(&json) {
                Ok(item) => items.push(item),
                Err(_) => {
                    let _ = fs::remove_file(&path);
                    cleaned = true;
                }
            }
        }
    }
    Ok((items, cleaned))
}

/// 压缩：把合并后的当前状态落成快照（每记录一个明文 JSON 文件 + snapshot.v 版本号），
/// 删除 ops/ 目录并清空 outbox（快照已代表全部变更）。
/// 返回快照版本号（合并基线）。
fn compact_to_snapshot(state: &AppState) -> AppResult<i64> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();

    let (notes_list, groups_list, accounts_list, documents_list, max_lp) = {
        let conn = state.db.lock().unwrap();
        let notes_list = notes::list(&conn)?;
        let groups_list = groups::list(&conn)?;
        let accounts_list = accounts::list(&conn)?;
        let documents_list = documents::list(&conn)?;
        let max_lp = outbox::max_lamport(&conn)?.max(outbox::current_lamport(&conn)?);
        (notes_list, groups_list, accounts_list, documents_list, max_lp)
    };

    write_records(&sync_dir, "notes", &notes_list, |n| &n.id)?;
    write_records(&sync_dir, "groups", &groups_list, |g| &g.id)?;
    write_records(&sync_dir, "accounts", &accounts_list, |a| &a.id)?;
    write_records(&sync_dir, "documents", &documents_list, |d| &d.id)?;
    fs::write(sync_dir.join(SNAPSHOT_VERSION_FILE), max_lp.to_string())?;

    // 同步加密文件本体
    let vault_dst = sync_dir.join(VAULT_SUBDIR);
    fs::create_dir_all(&vault_dst)?;
    for doc in &documents_list {
        let src = vault_dir.join(&doc.file_path);
        let dst = vault_dst.join(&doc.file_path);
        if src.exists() {
            fs::create_dir_all(dst.parent().unwrap_or(&vault_dst))?;
            fs::copy(&src, &dst)?;
        }
    }

    // 日志已并入快照：删除 ops 目录，清空 outbox
    let _ = fs::remove_dir_all(ops_dir(&sync_dir));
    let conn = state.db.lock().unwrap();
    outbox::clear(&conn)?;
    Ok(max_lp)
}

/// 快照导入：全量替换本地数据（仅在远端压缩落快照时触发），
/// 记录版本统一设为快照基线 N，之后把本地未推送操作按 LWW 重新套用上去。
fn import_snapshot(state: &AppState) -> AppResult<()> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();

    let baseline: i64 = fs::read_to_string(sync_dir.join(SNAPSHOT_VERSION_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    let (notes_list, notes_cleaned) = read_records::<notes::Note>(&sync_dir, "notes")?;
    let (groups_list, groups_cleaned) =
        read_records::<groups::NoteGroup>(&sync_dir, "groups")?;
    let (accounts_list, accounts_cleaned) =
        read_records::<accounts::Account>(&sync_dir, "accounts")?;
    let (documents_list, documents_cleaned) =
        read_records::<documents::Document>(&sync_dir, "documents")?;

    // 任一子目录清理过无法解析的旧版加密残留（旧版本全员加密的快照文件）：
    // 直接跳过本次导入，以本地数据为准，避免用不完整/空数据覆盖本地库。
    if notes_cleaned || groups_cleaned || accounts_cleaned || documents_cleaned {
        return Ok(());
    }

    let conn = state.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "DELETE FROM notes; DELETE FROM note_groups; DELETE FROM accounts; DELETE FROM documents;",
    )?;
    outbox::clear_tombstones(&tx)?;
    for g in &groups_list {
        tx.execute(
            "INSERT INTO note_groups (id, title, created_at, updated_at, v_lamport, v_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (&g.id, &g.title, &g.created_at, &g.updated_at, baseline, ""),
        )?;
    }
    for n in &notes_list {
        tx.execute(
            "INSERT INTO notes (id, title, mode, content, pinned, group_id, created_at, updated_at, v_lamport, v_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            (
                &n.id, &n.title, &n.mode, &n.content, n.pinned as i64,
                &n.group_id, &n.created_at, &n.updated_at, baseline, "",
            ),
        )?;
    }
    for a in &accounts_list {
        tx.execute(
            "INSERT INTO accounts (id, title, username, password_enc, url, notes, created_at, updated_at, v_lamport, v_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            (
                &a.id, &a.title, &a.username, &a.password_enc, &a.url, &a.notes,
                &a.created_at, &a.updated_at, baseline, "",
            ),
        )?;
    }
    for d in &documents_list {
        tx.execute(
            "INSERT INTO documents (id, title, file_name, file_path, size, mime, created_at, updated_at, v_lamport, v_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            (
                &d.id, &d.title, &d.file_name, &d.file_path, d.size, &d.mime,
                &d.created_at, &d.updated_at, baseline, "",
            ),
        )?;
        // 恢复资料文件本体
        let src = sync_dir.join(VAULT_SUBDIR).join(&d.file_path);
        if src.exists() {
            let dst = vault_dir.join(&d.file_path);
            fs::create_dir_all(dst.parent().unwrap_or(&vault_dir))?;
            fs::copy(&src, &dst)?;
        }
    }
    // 快照版本即合并基线：<= 基线的操作全部体现在快照中
    meta::set(&tx, "sync.baseline", &baseline.to_string())?;
    outbox::bump_lamport(&tx, baseline)?;
    tx.commit()?;

    // 本地未推送操作重新套用到快照之上（LWW：> 基线的生效，<= 基线的被快照覆盖）
    // 复用已持有的 conn 锁（std Mutex 不可重入，不能再锁一次）
    let pend = outbox::pending(&conn)?;
    let tx = conn.unchecked_transaction()?;
    for (_, op) in &pend {
        apply_op(&tx, op, &vault_dir, &sync_dir)?;
    }
    tx.commit()?;
    Ok(())
}

// ---------- 自动提交 / 后台同步 ----------

/// 数据变更后调用：标记待推送并在后台串行同步（静默，不打断用户操作）。
/// 未配置仓库 / 未保存 Token 时静默跳过（同步为明文，无需解锁）。
pub fn auto_commit(state: Arc<AppState>) {
    if state.repo_url.lock().unwrap().is_empty() {
        return;
    }
    if get_token().ok().flatten().is_none() {
        return;
    }
    *state.auto_push_pending.lock().unwrap() = true;
    emit_status(&state, "pending", "有变更待同步…");
    let st = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 串行化：同一时间只允许一个同步线程执行
        let _guard = st.push_lock.lock();
        loop {
            let more = {
                let mut pending = st.auto_push_pending.lock().unwrap();
                if *pending {
                    *pending = false;
                    true
                } else {
                    false
                }
            };
            if !more {
                return;
            }
            // 失败静默：不影响用户操作，下次变更或退出时兜底重试
            if push(&st).is_ok() {
                emit_status(&st, "synced", "已同步");
            } else {
                emit_status(&st, "error", "同步失败，将在下次变更时重试");
            }
        }
    });
}

/// 应用启动即开始的后台自动同步循环（同步为明文，无需解锁）：
/// 有本地变更立即同步；空闲时每 30 秒检查一次，距上次同步超过 2 分钟则定期同步。
pub fn start_background_sync(state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut first = true;
        loop {
            if !state.repo_url.lock().unwrap().is_empty()
                && *state.sync_auto.lock().unwrap()
            {
                let should_sync = first
                    || {
                        let pending = {
                            let conn = state.db.lock().unwrap();
                            outbox::pending(&conn)
                                .map(|p| !p.is_empty())
                                .unwrap_or(false)
                        };
                        if pending {
                            true
                        } else {
                            // 距上次同步超过 2 分钟则定期同步
                            let last = meta::get(&state.db.lock().unwrap(), "sync.last_sync_at")
                                .ok()
                                .flatten();
                            match last.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok()) {
                                Some(t) => {
                                    (chrono::Utc::now().timestamp()
                                        - t.with_timezone(&chrono::Utc).timestamp())
                                        >= 120
                                }
                                None => true,
                            }
                        }
                    };
                if should_sync {
                    emit_status(&state, "syncing", "正在同步…");
                    let _guard = state.push_lock.lock();
                    match push(&state) {
                        Ok(msg) => emit_status(&state, "synced", msg),
                        Err(e) => emit_status(&state, "error", format!("同步失败：{e}")),
                    }
                }
            }
            first = false;
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}

// ---------- push / pull / auto ----------

pub fn push(state: &AppState) -> AppResult<String> {
    if state.repo_url.lock().unwrap().is_empty() {
        return Err(AppError::sync("尚未配置同步仓库"));
    }
    let token = get_token()?.ok_or_else(|| AppError::sync("尚未保存 GitHub Token"))?;

    // 若本地仓库不存在，先克隆
    open_or_clone_repo(state, &token)?;

    let repo = Repository::open(state.sync_dir.lock().unwrap().clone())?;
    let branch = state.branch.lock().unwrap().clone();

    // 先拉取远端并尽量快进，避免推送被拒绝
    let proxy = effective_proxy(&state.git_proxy.lock().unwrap());
    fetch_and_ff(&repo, &token, &branch, &proxy)?;

    // 先合并远端增量到本地（增量回放 / 快照导入），保证推送的是合并后的状态
    let merged = merge_remote(state)?;

    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();

    // 收集本地未推送操作：同步 vault 文件本体 → 分批写入 .op 文件
    let pending_ids: Vec<i64> = {
        let conn = state.db.lock().unwrap();
        let pend = outbox::pending(&conn)?;
        if pend.is_empty() {
            Vec::new()
        } else {
            for (_, op) in &pend {
                if op.kind == "document" {
                    if op.op == "upsert" {
                        // 新资料的文件本体一并推送到仓库
                        if let Ok(doc) = serde_json::from_str::<documents::Document>(&op.data) {
                            let src = vault_dir.join(&doc.file_path);
                            let dst = sync_dir.join(VAULT_SUBDIR).join(&doc.file_path);
                            if src.exists() {
                                fs::create_dir_all(dst.parent().unwrap_or(&sync_dir.join(VAULT_SUBDIR)))?;
                                fs::copy(&src, &dst)?;
                            }
                        }
                    } else if let Ok(payload) =
                        serde_json::from_str::<serde_json::Value>(&op.data)
                    {
                        // 删除资料：清理仓库中的残留文件本体
                        if let Some(fp) = payload.get("filePath").and_then(|v| v.as_str()) {
                            let _ = fs::remove_file(sync_dir.join(VAULT_SUBDIR).join(fp));
                        }
                    }
                }
            }
            let ops: Vec<SyncOp> = pend.iter().map(|(_, op)| op.clone()).collect();
            for chunk in ops.chunks(OP_BATCH_SIZE) {
                write_op_batch(&sync_dir, chunk)?;
            }
            pend.iter().map(|(id, _)| *id).collect()
        }
    };

    // ops 文件过多时压缩落快照并清空日志；否则仅标记已推送
    if count_op_files(&sync_dir) >= COMPACT_THRESHOLD {
        compact_to_snapshot(state)?;
    } else if !pending_ids.is_empty() {
        let conn = state.db.lock().unwrap();
        outbox::mark_pushed(&conn, &pending_ids)?;
    }

    // 暂存全部变更并提交
    let mut index = repo.index()?;
    index.add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    // 使用固定签名，避免本机未配置 git user.name/email 时无法提交
    let sig = git2::Signature::now("UUNote Sync", "sync@uunote.local")?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let msg = format!("sync {}", Utc::now().format("%Y-%m-%d %H:%M:%S"));
    repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parents)?;

    // 确保推送源分支存在：本地 HEAD 可能落在默认分支（如 master）上，
    // 需将配置分支指向当前提交并切换 HEAD，避免 push 时找不到 ref
    let want = format!("refs/heads/{branch}");
    let head_ref = repo.head()?;
    let head_commit = head_ref.peel_to_commit()?;
    if head_ref.name() != Some(want.as_str()) {
        repo.reference(&want, head_commit.id(), true, "sync branch")?;
        repo.set_head(&want)?;
    }

    // 推送
    let mut remote = repo.find_remote("origin")?;
    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(remote_callbacks(&token));
    push_opts.proxy_options(proxy_options(&proxy));
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[&refspec], Some(&mut push_opts))?;

    let now = Utc::now().to_rfc3339();
    meta::set(&state.db.lock().unwrap(), "sync.last_sync_at", &now)?;
    let suffix = if merged > 0 {
        format!("，合并了 {merged} 条远端变更")
    } else {
        String::new()
    };
    Ok(format!("已同步{suffix}（{}）", now))
}

pub fn pull(state: &AppState) -> AppResult<String> {
    if state.repo_url.lock().unwrap().is_empty() {
        return Err(AppError::sync("尚未配置同步仓库"));
    }
    let token = get_token()?.ok_or_else(|| AppError::sync("尚未保存 GitHub Token"))?;

    open_or_clone_repo(state, &token)?;
    let repo = Repository::open(state.sync_dir.lock().unwrap().clone())?;
    let branch = state.branch.lock().unwrap().clone();
    let proxy = effective_proxy(&state.git_proxy.lock().unwrap());

    fetch_and_ff(&repo, &token, &branch, &proxy)?;

    // 远端为空仓库（本地尚无提交）时无数据可拉取，提示用户先推送
    if repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .is_none()
    {
        return Ok("远端仓库为空：暂无数据可拉取，可直接「同步」完成首次同步".to_string());
    }

    let merged = merge_remote(state)?;

    let now = Utc::now().to_rfc3339();
    meta::set(&state.db.lock().unwrap(), "sync.last_sync_at", &now)?;
    let suffix = if merged > 0 {
        format!("，合并了 {merged} 条远端变更")
    } else {
        String::new()
    };
    Ok(format!("已拉取{suffix}（{}）", now))
}

/// 自动同步（保存配置后调用）：远端为空仓库 → 自动初始化并推送；
/// 远端已有内容 → 自动拉取 + 推送本地增量。实现「保存即同步」。
pub fn auto_sync(state: &AppState) -> AppResult<String> {
    push(state)
}

/// fetch 远端并尽量快进合并到本地分支
fn fetch_and_ff(repo: &Repository, token: &str, branch: &str, proxy: &str) -> AppResult<()> {
    let mut remote = repo.find_remote("origin")?;
    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(remote_callbacks(token));
    fetch_opts.proxy_options(proxy_options(proxy));

    // FETCH_HEAD 是每次 fetch 的临时记录，上次中断（超时/网络错误）可能留下损坏文件，
    // 先清理避免 libgit2 读取时报 "corrupted loose reference file: FETCH_HEAD"
    let fetch_head_path = repo.path().join("FETCH_HEAD");
    let _ = fs::remove_file(&fetch_head_path);

    remote.fetch(&[branch], Some(&mut fetch_opts), None)?;

    // 远端没有匹配的引用（空仓库或分支不存在）时，FETCH_HEAD 会被写成空文件，
    // libgit2 会把它误报为损坏引用；这里探测远端后给出明确处理
    if fs::read_to_string(&fetch_head_path)
        .map(|s| s.trim().is_empty())
        .unwrap_or(false)
    {
        // 探测远端：完全为空 → 等首次推送；远端有分支但拉不到配置分支 → 分支名错误
        let url = repo
            .find_remote("origin")
            .ok()
            .and_then(|r| r.url().map(|s| s.to_string()));
        if let Some(url) = url {
            let remote_empty = remote_is_empty(proxy, token, &url);
            if !remote_empty {
                return Err(AppError::sync(format!(
                    "远端分支 '{branch}' 不存在：请检查设置中的分支名是否与 GitHub 仓库一致"
                )));
            }
        }
        return Ok(()); // 远端为空仓库，无可拉取内容
    }

    let fetch_head = match repo.find_reference("FETCH_HEAD") {
        Ok(h) => h,
        Err(_) => {
            // 兜底：仍读取失败则再次删除后重试 fetch 一次
            let _ = fs::remove_file(&fetch_head_path);
            remote.fetch(&[branch], Some(&mut fetch_opts), None)?;
            repo.find_reference("FETCH_HEAD")?
        }
    };
    let fetch_commit = repo.reference_to_annotated_commit(&fetch_head)?;
    let analysis = repo.merge_analysis(&[&fetch_commit])?;

    if analysis.0.is_fast_forward() {
        let refname = format!("refs/heads/{branch}");
        // 本地分支可能不存在（如首次同步/仓库由空变有内容），此时直接创建
        match repo.find_reference(&refname) {
            Ok(mut reference) => {
                reference.set_target(fetch_commit.id(), "Fast-forward")?;
            }
            Err(_) => {
                repo.reference(&refname, fetch_commit.id(), true, "create branch")?;
            }
        }
        repo.set_head(&refname)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
    } else if analysis.0.is_up_to_date() {
        // 已是最新
    } else {
        // 分叉：增量日志架构下以合并回放为准，本地重置到远端后由 merge_remote 应用
        let obj = repo.find_object(fetch_commit.id(), None)?;
        repo.reset(&obj, ResetType::Hard, None)?;
    }
    Ok(())
}
