//! 全局应用状态：数据库连接、主密钥（内存）、vault/sync 目录

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::Connection;
use serde::Serialize;

use crate::crypto;
use crate::db;
use crate::db::accounts;
use crate::db::meta;
use crate::error::{AppError, AppResult};

/// 记录自定义数据目录的指针文件名（存放在默认应用数据目录下）
const DATA_DIR_POINTER_FILE: &str = "data_dir.conf";

/// 同步状态（前端通过 sync://status 事件实时感知）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// idle | pending | syncing | synced | error
    pub state: String,
    pub message: String,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    /// 解锁后持有的主密钥，仅存内存，从不落盘
    master_key: Mutex<Option<[u8; crypto::KEY_LEN]>>,
    /// 解锁后持有的主密码明文（仅存内存），用于从快照公开盐派生快照密钥
    master_password: Mutex<Option<String>>,
    /// 当前数据目录（数据库、vault、sync 的父目录）
    pub data_dir: Mutex<PathBuf>,
    /// 加密资料文件本体存放目录
    pub vault_dir: Mutex<PathBuf>,
    /// Git 同步工作目录
    pub sync_dir: Mutex<PathBuf>,
    pub repo_url: Mutex<String>,
    pub branch: Mutex<String>,
    /// Git 代理地址（可选，用于访问 GitHub 较慢/被墙的网络环境）
    pub git_proxy: Mutex<String>,
    /// 自动提交串行锁：同一时间只允许一个自动推送线程执行，避免 git 并发操作冲突
    pub push_lock: Mutex<()>,
    /// 待推送标记：数据变更落库后置 true，后台推送线程消费
    pub auto_push_pending: Mutex<bool>,
    /// 前端事件发射所需的 AppHandle（setup 时注入，供同步线程向前端推事件）
    pub app_handle: Mutex<Option<tauri::AppHandle>>,
    /// 当前同步状态（内存副本 + 推送给前端）
    pub sync_status: Mutex<SyncStatus>,
    /// 自动同步开关（设置页可切换）
    pub sync_auto: Mutex<bool>,
}

/// 解析最终数据目录：默认目录下存在指针文件（自定义位置）则优先使用；
/// 指针指向的目录已不存在（如外接盘被移除）时回退到默认目录，避免数据丢失。
pub fn resolve_data_dir(default_dir: &Path) -> AppResult<PathBuf> {
    let pointer = default_dir.join(DATA_DIR_POINTER_FILE);
    if let Ok(content) = std::fs::read_to_string(&pointer) {
        let p = PathBuf::from(content.trim());
        if p.is_dir() {
            return Ok(p);
        }
    }
    Ok(default_dir.to_path_buf())
}

/// 根据应用数据目录初始化状态（建库、建目录、读取同步配置）
pub fn init(data_dir: PathBuf) -> AppResult<AppState> {
    let vault_dir = data_dir.join("vault");
    let sync_dir = data_dir.join("sync");
    std::fs::create_dir_all(&vault_dir)?;
    std::fs::create_dir_all(&sync_dir)?;

    let db_path = data_dir.join("uunote.db");
    let conn = db::open(&db_path)?;

    let repo_url = meta::get(&conn, "sync.repo_url")?.unwrap_or_default();
    let branch = meta::get(&conn, "sync.branch")?.unwrap_or_else(|| "main".into());
    let git_proxy = meta::get(&conn, "sync.git_proxy")?.unwrap_or_default();
    let sync_auto = meta::get(&conn, "sync.auto")?
        .map(|v| v != "false")
        .unwrap_or(true);

    Ok(AppState {
        db: Mutex::new(conn),
        master_key: Mutex::new(None),
        master_password: Mutex::new(None),
        data_dir: Mutex::new(data_dir),
        vault_dir: Mutex::new(vault_dir),
        sync_dir: Mutex::new(sync_dir),
        repo_url: Mutex::new(repo_url),
        branch: Mutex::new(branch),
        git_proxy: Mutex::new(git_proxy),
        push_lock: Mutex::new(()),
        auto_push_pending: Mutex::new(false),
        app_handle: Mutex::new(None),
        sync_status: Mutex::new(SyncStatus {
            state: "idle".into(),
            message: "等待同步".into(),
        }),
        sync_auto: Mutex::new(sync_auto),
    })
}

impl AppState {
    pub fn is_locked(&self) -> bool {
        self.master_key.lock().unwrap().is_none()
    }

    /// 取主密钥（拷贝一份，供加密调用）
    pub fn master_key(&self) -> AppResult<[u8; crypto::KEY_LEN]> {
        let guard = self.master_key.lock().unwrap();
        guard.as_ref().copied().ok_or(AppError::Locked)
    }

    /// 取解锁后的主密码（仅内存），用于从快照公开盐派生快照密钥
    pub fn master_password(&self) -> AppResult<String> {
        self.master_password
            .lock()
            .unwrap()
            .clone()
            .ok_or(AppError::Locked)
    }

    /// 导入快照后切换内存主密钥（本地解锁信息已同步为快照密钥体系）
    pub fn set_master_key(&self, key: [u8; crypto::KEY_LEN]) {
        *self.master_key.lock().unwrap() = Some(key);
    }

    /// 首次使用：生成盐、派生密钥、存魔术串
    pub fn setup_master_password(&self, password: &str) -> AppResult<()> {
        let conn = self.db.lock().unwrap();
        if meta::get(&conn, "salt")?.is_some() {
            return Err(AppError::BadPassword);
        }
        let salt = crypto::generate_salt();
        let key = crypto::derive_key(password, &salt)?;
        let magic = crypto::encrypt_magic(&key)?;
        meta::set(&conn, "salt", &crypto::to_b64(&salt))?;
        meta::set(&conn, "master_magic", &magic)?;
        *self.master_key.lock().unwrap() = Some(key);
        *self.master_password.lock().unwrap() = Some(password.to_string());
        Ok(())
    }

    /// 解锁：由密码+盐派生密钥并校验魔术串
    pub fn unlock(&self, password: &str) -> AppResult<()> {
        let conn = self.db.lock().unwrap();
        let salt_b64 = meta::get(&conn, "salt")?
            .ok_or_else(|| AppError::other("尚未初始化，请先设置主密码"))?;
        let magic = meta::get(&conn, "master_magic")?
            .ok_or_else(|| AppError::other("初始化数据缺失"))?;
        let salt = crypto::from_b64(&salt_b64)?;
        let key = crypto::derive_key(password, &salt)?;
        if !crypto::verify_magic(&key, &magic) {
            return Err(AppError::BadPassword);
        }
        *self.master_key.lock().unwrap() = Some(key);
        *self.master_password.lock().unwrap() = Some(password.to_string());
        Ok(())
    }

    pub fn lock(&self) {
        *self.master_key.lock().unwrap() = None;
        *self.master_password.lock().unwrap() = None;
    }

    /// 修改主密码：验证旧密码后，重新派生密钥并重加密全部敏感数据
    /// （账号密码密文、vault 资料文件），最后更新 salt 与魔术串。
    pub fn change_master_password(&self, old_password: &str, new_password: &str) -> AppResult<()> {
        if new_password.is_empty() {
            return Err(AppError::other("新密码不能为空"));
        }
        let conn = self.db.lock().unwrap();
        let old_salt_b64 = meta::get(&conn, "salt")?
            .ok_or_else(|| AppError::other("尚未初始化，请先设置主密码"))?;
        let magic = meta::get(&conn, "master_magic")?
            .ok_or_else(|| AppError::other("初始化数据缺失"))?;
        let old_salt = crypto::from_b64(&old_salt_b64)?;
        let old_key = crypto::derive_key(old_password, &old_salt)?;
        if !crypto::verify_magic(&old_key, &magic) {
            return Err(AppError::BadPassword);
        }

        let new_salt = crypto::generate_salt();
        let new_key = crypto::derive_key(new_password, &new_salt)?;

        // 预检：确认全部敏感数据都能用旧密钥解密，避免迁移中途失败损坏数据
        let acc_list = accounts::list(&conn)?;
        for a in &acc_list {
            if !a.password_enc.is_empty() {
                let data = crypto::from_b64(&a.password_enc)?;
                crypto::decrypt(&old_key, &data)?;
            }
        }
        let vault_dir = self.vault_dir.lock().unwrap().clone();
        let mut enc_files = Vec::new();
        for entry in std::fs::read_dir(&vault_dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|e| e.to_str()) == Some("enc") {
                let encrypted = std::fs::read(entry.path())?;
                crypto::decrypt(&old_key, &encrypted)?;
                enc_files.push(entry.path());
            }
        }
        drop(conn);

        // 迁移数据库内的账号密码密文 + 更新解锁信息（同一事务）
        let conn = self.db.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for a in &acc_list {
            let new_enc = if a.password_enc.is_empty() {
                String::new()
            } else {
                let data = crypto::from_b64(&a.password_enc)?;
                let plain = crypto::decrypt(&old_key, &data)?;
                B64.encode(crypto::encrypt(&new_key, &plain)?)
            };
            tx.execute(
                "UPDATE accounts SET password_enc = ?1 WHERE id = ?2",
                (&new_enc, &a.id),
            )?;
        }
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("salt", &crypto::to_b64(&new_salt)),
        )?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("master_magic", &crypto::encrypt_magic(&new_key)?),
        )?;
        tx.commit()?;
        drop(conn);

        // 重加密 vault 资料文件（先写临时文件再替换，避免写坏）
        for path in &enc_files {
            let encrypted = std::fs::read(path)?;
            let plain = crypto::decrypt(&old_key, &encrypted)?;
            let new_enc = crypto::encrypt(&new_key, &plain)?;
            let tmp = path.with_extension("enc.tmp");
            std::fs::write(&tmp, &new_enc)?;
            std::fs::rename(&tmp, path)?;
        }

        // 更新内存中的主密钥与主密码
        *self.master_key.lock().unwrap() = Some(new_key);
        *self.master_password.lock().unwrap() = Some(new_password.to_string());
        Ok(())
    }

    /// 更改数据存储位置：把数据库、vault、sync 迁移到新目录，
    /// 并在默认目录写入指针文件，下次启动自动使用新位置。
    /// 返回最终生效的数据目录（规范化后）。
    pub fn set_data_dir(&self, new_dir: PathBuf, default_dir: &Path) -> AppResult<String> {
        let new_dir = new_dir.canonicalize().unwrap_or_else(|_| new_dir.clone());
        let cur_dir = self.data_dir.lock().unwrap().clone();
        if new_dir == cur_dir {
            return Ok(new_dir.to_string_lossy().to_string());
        }
        if new_dir.starts_with(&cur_dir) {
            return Err(AppError::other("新位置不能是当前数据目录的子目录"));
        }
        if new_dir.join("uunote.db").exists() {
            return Err(AppError::other("目标目录已存在 UUNote 数据，为避免覆盖，请选择空目录"));
        }
        std::fs::create_dir_all(&new_dir)?;

        // 关闭旧数据库连接（drop 触发 SQLite 正常关闭并检查点 WAL）
        let mut guard = self.db.lock().unwrap();
        let old_conn = std::mem::replace(&mut *guard, Connection::open_in_memory()?);
        drop(old_conn);

        // 迁移数据：数据库文件（含可能残留的 WAL/SHM）、vault、sync
        for entry in std::fs::read_dir(&cur_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("uunote.db") {
                move_path(&entry.path(), &new_dir.join(name))?;
            }
        }
        move_path(&cur_dir.join("vault"), &new_dir.join("vault"))?;
        move_path(&cur_dir.join("sync"), &new_dir.join("sync"))?;

        // 在新位置重开数据库，更新内存状态
        *guard = db::open(&new_dir.join("uunote.db"))?;
        drop(guard);

        *self.data_dir.lock().unwrap() = new_dir.clone();
        *self.vault_dir.lock().unwrap() = new_dir.join("vault");
        *self.sync_dir.lock().unwrap() = new_dir.join("sync");

        // 重新读取同步配置（数据已整体迁移，内容应一致）
        let conn = self.db.lock().unwrap();
        *self.repo_url.lock().unwrap() = meta::get(&conn, "sync.repo_url")?.unwrap_or_default();
        *self.branch.lock().unwrap() =
            meta::get(&conn, "sync.branch")?.unwrap_or_else(|| "main".into());
        *self.git_proxy.lock().unwrap() = meta::get(&conn, "sync.git_proxy")?.unwrap_or_default();
        *self.sync_auto.lock().unwrap() = meta::get(&conn, "sync.auto")?
            .map(|v| v != "false")
            .unwrap_or(true);
        drop(conn);

        // 写入指针文件，下次启动自动使用新位置
        std::fs::create_dir_all(default_dir)?;
        std::fs::write(
            default_dir.join(DATA_DIR_POINTER_FILE),
            new_dir.to_string_lossy().as_bytes(),
        )?;

        Ok(new_dir.to_string_lossy().to_string())
    }
}

/// 跨盘符安全的移动：优先 rename，失败（不同盘符）则复制后删除
fn move_path(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        std::fs::create_dir_all(dst)?;
        return Ok(());
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            move_path(&entry.path(), &dst.join(entry.file_name()))?;
        }
        std::fs::remove_dir_all(src)?;
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
        std::fs::remove_file(src)?;
    }
    Ok(())
}
