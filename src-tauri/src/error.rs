//! 统一的错误类型，命令层转换为字符串返回给前端

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("应用未解锁")]
    Locked,

    #[error("主密码错误")]
    BadPassword,

    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("加密错误: {0}")]
    Crypto(String),

    #[error("同步错误: {0}")]
    Sync(String),

    #[error("凭据存储错误: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("内部错误: {0}")]
    Other(String),
}

impl AppError {
    pub fn crypto(msg: impl Into<String>) -> Self {
        AppError::Crypto(msg.into())
    }

    pub fn sync(msg: impl Into<String>) -> Self {
        AppError::Sync(msg.into())
    }

    pub fn other(msg: impl Into<String>) -> Self {
        AppError::Other(msg.into())
    }
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        AppError::Sync(e.message().to_string())
    }
}

impl From<argon2::password_hash::Error> for AppError {
    fn from(e: argon2::password_hash::Error) -> Self {
        AppError::crypto(format!("密钥派生失败: {e}"))
    }
}

impl From<argon2::Error> for AppError {
    fn from(e: argon2::Error) -> Self {
        AppError::crypto(format!("密钥派生参数错误: {e}"))
    }
}

impl From<aes_gcm::Error> for AppError {
    fn from(e: aes_gcm::Error) -> Self {
        AppError::crypto(format!("AES 加解密失败: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
