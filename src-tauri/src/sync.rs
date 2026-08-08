//! GitHub 云同步：内嵌 git2 推送/拉取加密快照，Token 存 Windows 凭据管理器
//!
//! 同步内容 = 一份用主密钥加密的整体快照（笔记 + 账号密文 + 资料元数据）
//!           + vault 目录中的加密文件本体。仓库中不存在任何明文数据。

use std::fs;
use std::sync::Arc;

use chrono::Utc;
use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository, ResetType};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::db::{accounts, documents, meta, notes};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const KEYRING_SERVICE: &str = "com.zouni.uunote";
pub const KEYRING_TOKEN_USER: &str = "github_token";

/// 快照文件名（位于仓库根目录，始终加密）
const SNAPSHOT_FILE: &str = "snapshot.enc";
/// 快照公开盐文件：明文 base64(salt)，随快照一起推送。
/// 任何设备用「主密码 + 该盐」即可派生同一密钥解密快照（跨设备可恢复）。
const SNAPSHOT_SALT_FILE: &str = "snapshot.salt";
const VAULT_SUBDIR: &str = "vault";

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    exported_at: String,
    notes: Vec<notes::Note>,
    accounts: Vec<accounts::Account>,
    documents: Vec<documents::Document>,
    /// 解锁所需的最小 meta 子集（盐、魔术串）
    salt: Option<String>,
    magic: Option<String>,
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
    let has_token = get_token()?.is_some();
    Ok(Some(SyncConfig {
        repo_url,
        branch,
        git_proxy,
        last_sync_at,
        has_token,
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

// ---------- 快照导出 / 导入 ----------
//
// 同步内容按「每记录一个加密文件」组织，未变化的文件 git 天然增量：
//   snapshot.salt  —— 快照公开盐（明文 base64，跨设备用主密码派生同一密钥）
//   notes/*.json   —— 每个笔记一个加密文件
//   accounts/*.json—— 每个账号一个加密文件
//   documents/*.json—— 每个资料一条加密元数据
//   vault/         —— 加密文件本体
// 旧版整体快照 snapshot.enc 仅用于导入兼容，导出时删除。

/// 生成解密/加密快照文件的密钥：
/// 优先用「快照公开盐 + 内存中的主密码」派生（跨设备可复现）；
/// 无盐文件时回退本地主密钥（兼容旧版快照）。
fn snapshot_key(state: &AppState, sync_dir: &std::path::Path) -> AppResult<[u8; crypto::KEY_LEN]> {
    let salt_path = sync_dir.join(SNAPSHOT_SALT_FILE);
    if let Ok(pwd) = state.master_password() {
        if let Ok(salt_b64) = fs::read_to_string(&salt_path) {
            if let Ok(salt) = crypto::from_b64(salt_b64.trim()) {
                return crypto::derive_key(&pwd, &salt);
            }
        }
    }
    state.master_key()
}

/// 确保快照公开盐文件存在：首次导出时用本地 meta 的 salt 生成（之后固定不变）
fn ensure_snapshot_salt(state: &AppState) -> AppResult<()> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let salt_path = sync_dir.join(SNAPSHOT_SALT_FILE);
    if salt_path.exists() {
        return Ok(());
    }
    let conn = state.db.lock().unwrap();
    let salt = meta::get(&conn, "salt")?
        .ok_or_else(|| AppError::sync("初始化数据缺失：无法生成快照盐"))?;
    fs::write(&salt_path, salt)?;
    Ok(())
}

/// 把一批记录各写成一个加密 JSON 文件，并清理已删除记录的残留文件
fn write_records<T: Serialize>(
    sync_dir: &std::path::Path,
    subdir: &str,
    items: &[T],
    id_of: impl Fn(&T) -> &str,
    key: &[u8; crypto::KEY_LEN],
) -> AppResult<()> {
    let dir = sync_dir.join(subdir);
    fs::create_dir_all(&dir)?;
    let alive: std::collections::HashSet<String> =
        items.iter().map(|i| id_of(i).to_string()).collect();
    for item in items {
        let json = serde_json::to_vec_pretty(item)?;
        let enc = crypto::encrypt(key, &json)?;
        fs::write(dir.join(format!("{}.json", id_of(item))), enc)?;
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

/// 读取某个子目录下的全部记录文件
fn read_records<T: serde::de::DeserializeOwned>(
    sync_dir: &std::path::Path,
    subdir: &str,
    key: &[u8; crypto::KEY_LEN],
) -> AppResult<Vec<T>> {
    let dir = sync_dir.join(subdir);
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries {
            let entry = entry?;
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let enc = fs::read(entry.path())?;
            let json = crypto::decrypt(key, &enc)?;
            items.push(serde_json::from_slice::<T>(&json)?);
        }
    }
    Ok(items)
}

pub fn export_snapshot(state: &AppState) -> AppResult<()> {
    ensure_snapshot_salt(state)?;
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();
    let conn = state.db.lock().unwrap();
    let key = snapshot_key(state, &sync_dir)?;

    let notes = notes::list(&conn)?;
    let accounts = accounts::list(&conn)?;
    let documents = documents::list(&conn)?;

    write_records(&sync_dir, "notes", &notes, |n| &n.id, &key)?;
    write_records(&sync_dir, "accounts", &accounts, |a| &a.id, &key)?;
    write_records(&sync_dir, "documents", &documents, |d| &d.id, &key)?;

    // 旧版整体快照：迁移到新架构后不再生成，删除之
    let _ = fs::remove_file(sync_dir.join(SNAPSHOT_FILE));

    // 同步加密文件本体
    let vault_dst = sync_dir.join(VAULT_SUBDIR);
    fs::create_dir_all(&vault_dst)?;
    for doc in &documents {
        let src = vault_dir.join(&doc.file_path);
        let dst = vault_dst.join(&doc.file_path);
        if src.exists() {
            fs::create_dir_all(dst.parent().unwrap_or(&vault_dst))?;
            fs::copy(&src, &dst)?;
        }
    }
    // 清理仓库中已删除资料的残留文件
    for entry in fs::read_dir(&vault_dst)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let still_exists = documents.iter().any(|d| d.file_path == name);
        if !still_exists {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

pub fn import_snapshot(state: &AppState) -> AppResult<()> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();
    let key = snapshot_key(state, &sync_dir)?;

    // 旧版整体快照（snapshot.enc）：走全量导入
    let enc_path = sync_dir.join(SNAPSHOT_FILE);
    if enc_path.exists() {
        return import_snapshot_legacy(state, &enc_path, &key);
    }

    // 新版：每记录一个加密文件
    let notes: Vec<notes::Note> = read_records(&sync_dir, "notes", &key)?;
    let accounts: Vec<accounts::Account> = read_records(&sync_dir, "accounts", &key)?;
    let documents: Vec<documents::Document> = read_records(&sync_dir, "documents", &key)?;

    let conn = state.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM notes; DELETE FROM accounts; DELETE FROM documents;")?;
    for n in &notes {
        tx.execute(
            "INSERT INTO notes (id, title, blocks, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                &n.id, &n.title, &n.blocks,
                n.pinned as i64, &n.created_at, &n.updated_at,
            ),
        )?;
    }
    for a in &accounts {
        tx.execute(
            "INSERT INTO accounts (id, title, username, password_enc, url, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&a.id, &a.title, &a.username, &a.password_enc, &a.url, &a.notes, &a.created_at, &a.updated_at),
        )?;
    }
    for d in &documents {
        tx.execute(
            "INSERT INTO documents (id, title, file_name, file_path, size, mime, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&d.id, &d.title, &d.file_name, &d.file_path, d.size, &d.mime, &d.created_at, &d.updated_at),
        )?;
        // 恢复加密文件本体
        let src = sync_dir.join(VAULT_SUBDIR).join(&d.file_path);
        if src.exists() {
            let dst = vault_dir.join(&d.file_path);
            fs::create_dir_all(dst.parent().unwrap_or(&vault_dir))?;
            fs::copy(&src, &dst)?;
        }
    }

    // 解锁信息切换到快照密钥体系：跨设备后本地也能用相同主密码解锁并解密数据
    let salt_path = sync_dir.join(SNAPSHOT_SALT_FILE);
    if let Ok(salt_b64) = fs::read_to_string(&salt_path) {
        let salt_b64 = salt_b64.trim().to_string();
        meta::set(&tx, "salt", &salt_b64)?;
        meta::set(&tx, "master_magic", &crypto::encrypt_magic(&key)?)?;
        state.set_master_key(key);
    }
    tx.commit()?;
    Ok(())
}

/// 旧版整体快照导入（兼容已推送到仓库的 snapshot.enc）
fn import_snapshot_legacy(
    state: &AppState,
    enc_path: &std::path::Path,
    key: &[u8; crypto::KEY_LEN],
) -> AppResult<()> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let vault_dir = state.vault_dir.lock().unwrap().clone();
    let encrypted = fs::read(enc_path)?;
    let json = crypto::decrypt(key, &encrypted)?;
    let snapshot: Snapshot = serde_json::from_slice(&json)?;

    let conn = state.db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM notes; DELETE FROM accounts; DELETE FROM documents;")?;
    for n in &snapshot.notes {
        tx.execute(
            "INSERT INTO notes (id, title, blocks, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                &n.id, &n.title, &n.blocks,
                n.pinned as i64, &n.created_at, &n.updated_at,
            ),
        )?;
    }
    for a in &snapshot.accounts {
        tx.execute(
            "INSERT INTO accounts (id, title, username, password_enc, url, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&a.id, &a.title, &a.username, &a.password_enc, &a.url, &a.notes, &a.created_at, &a.updated_at),
        )?;
    }
    for d in &snapshot.documents {
        tx.execute(
            "INSERT INTO documents (id, title, file_name, file_path, size, mime, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&d.id, &d.title, &d.file_name, &d.file_path, d.size, &d.mime, &d.created_at, &d.updated_at),
        )?;
        let src = sync_dir.join(VAULT_SUBDIR).join(&d.file_path);
        if src.exists() {
            let dst = vault_dir.join(&d.file_path);
            fs::create_dir_all(dst.parent().unwrap_or(&vault_dir))?;
            fs::copy(&src, &dst)?;
        }
    }
    // 保留解锁所需 meta
    if let Some(salt) = &snapshot.salt {
        meta::set(&tx, "salt", salt)?;
    }
    if let Some(magic) = &snapshot.magic {
        meta::set(&tx, "master_magic", magic)?;
    }
    tx.commit()?;
    state.set_master_key(*key);
    Ok(())
}

// ---------- 自动提交 ----------

/// 笔记等数据变更后调用：后台自动提交并推送。
/// 未配置仓库 / 未解锁 / 未保存 Token 时静默跳过，不打断用户操作。
/// 后台串行执行（push_lock），避免并发推送互相冲突。
pub fn auto_commit(state: Arc<AppState>) {
    if state.is_locked() || state.repo_url.lock().unwrap().is_empty() {
        return;
    }
    if get_token().ok().flatten().is_none() {
        return;
    }
    *state.auto_push_pending.lock().unwrap() = true;
    let st = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 串行化：同一时间只允许一个推送线程执行
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
            let _ = push(&st);
        }
    });
}

// ---------- push / pull ----------

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

    // 数据安全：推送覆盖前必须验证本地密钥能解开远端快照。
    // 若密钥不匹配（密码/数据目录与当初不同），推送会把远端有效数据静默覆盖，
    // 因此这里直接中止，避免误用错误密码毁掉旧数据。
    verify_remote_snapshot(state)?;

    // 生成加密快照（含 vault 文件），再提交推送
    export_snapshot(state)?;

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
    Ok(format!("推送成功（{}）", now))
}

/// 推送前校验：远端快照能否用本地密钥（快照公开盐 + 主密码）解密。
/// 无法解密则中止推送，防止误用错误密钥/数据目录覆盖远端有效数据。
fn verify_remote_snapshot(state: &AppState) -> AppResult<()> {
    let sync_dir = state.sync_dir.lock().unwrap().clone();
    let key = snapshot_key(state, &sync_dir)?;

    // 旧版整体快照
    let enc_path = sync_dir.join(SNAPSHOT_FILE);
    if enc_path.exists() {
        let encrypted = fs::read(&enc_path)?;
        if crypto::decrypt(&key, &encrypted).is_err() {
            return Err(AppError::sync(
                "本地密钥与远端快照不匹配，已中止推送（防止覆盖远端已有数据）。\
                 请确认当前使用的是当初加密该快照的主密码；\
                 若确认要放弃远端旧数据、以本地数据为准，请先在 GitHub 上手动备份或删除该快照后再操作。",
            ));
        }
        return Ok(());
    }

    // 新版：尝试解密任意一个数据文件来验证密钥匹配
    for sub in ["notes", "accounts", "documents"] {
        let dir = sync_dir.join(sub);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let enc = fs::read(entry.path())?;
                if crypto::decrypt(&key, &enc).is_err() {
                    return Err(AppError::sync(
                        "本地密钥与远端快照不匹配，已中止推送（防止覆盖远端已有数据）。\
                         请确认当前使用的是当初加密该快照的主密码；\
                         若确认要放弃远端旧数据、以本地数据为准，请先在 GitHub 上手动备份或删除该快照后再操作。",
                    ));
                }
                return Ok(());
            }
        }
    }
    // 无任何数据文件（远端为空仓库）：无历史数据，允许首次推送
    Ok(())
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
        return Ok("远端仓库为空：暂无数据可拉取，可直接「推送」完成首次同步".to_string());
    }

    // 快照可能已变化，重新导入
    import_snapshot(state)?;
    let now = Utc::now().to_rfc3339();
    meta::set(&state.db.lock().unwrap(), "sync.last_sync_at", &now)?;
    Ok(format!("拉取成功（{}）", now))
}

/// 自动同步（保存配置后调用）：远端为空仓库 → 自动初始化并推送；
/// 远端已有内容 → 自动拉取。实现「保存即同步」。
pub fn auto_sync(state: &AppState) -> AppResult<String> {
    if state.repo_url.lock().unwrap().is_empty() {
        return Err(AppError::sync("尚未配置同步仓库"));
    }
    let token = get_token()?.ok_or_else(|| AppError::sync("尚未保存 GitHub Token"))?;

    // 打开或初始化本地仓库（远端为空时本地初始化，等待首次推送）
    open_or_clone_repo(state, &token)?;

    let repo_url = state.repo_url.lock().unwrap().clone();
    let proxy = effective_proxy(&state.git_proxy.lock().unwrap());

    if remote_is_empty(&proxy, &token, &repo_url) {
        push(state)
    } else {
        pull(state)
    }
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
        // 分叉：本地快照整体覆盖，直接 reset 到远端（单用户场景可接受）
        let obj = repo.find_object(fetch_commit.id(), None)?;
        repo.reset(&obj, ResetType::Hard, None)?;
    }
    Ok(())
}
