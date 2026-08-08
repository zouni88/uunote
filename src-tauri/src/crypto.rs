//! 加密层：主密码 → Argon2id 派生 AES-256 密钥，敏感数据用 AES-256-GCM 加解密

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;

use crate::error::{AppError, AppResult};

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;

/// 主密码校验用的魔术串，用主密钥加密后存库，解锁时解出即代表密码正确
const MAGIC: &[u8] = b"uunote-master-key-ok";

/// 生成随机盐
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Argon2id 从主密码派生 32 字节密钥
pub fn derive_key(password: &str, salt: &[u8]) -> AppResult<[u8; KEY_LEN]> {
    let params = Params::new(64 * 1024, 3, 4, Some(KEY_LEN))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| AppError::crypto("密钥派生失败"))?;
    Ok(key)
}

/// AES-256-GCM 加密：返回 nonce || ciphertext
pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), plaintext)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// 解密 encrypt() 的输出
pub fn decrypt(key: &[u8; KEY_LEN], data: &[u8]) -> AppResult<Vec<u8>> {
    if data.len() <= NONCE_LEN {
        return Err(AppError::crypto("密文格式非法"));
    }
    let (nonce, ciphertext) = data.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher.decrypt(Nonce::from_slice(nonce), ciphertext)?;
    Ok(plaintext)
}

/// 用主密钥加密魔术串，供解锁时校验密码
pub fn encrypt_magic(key: &[u8; KEY_LEN]) -> AppResult<String> {
    Ok(B64.encode(encrypt(key, MAGIC)?))
}

/// 校验魔术串密文：解出即为密码正确
pub fn verify_magic(key: &[u8; KEY_LEN], encoded: &str) -> bool {
    let Ok(data) = B64.decode(encoded) else {
        return false;
    };
    decrypt(key, &data).map(|p| p.as_slice() == MAGIC).unwrap_or(false)
}

pub fn to_b64(data: &[u8]) -> String {
    B64.encode(data)
}

pub fn from_b64(s: &str) -> AppResult<Vec<u8>> {
    B64.decode(s).map_err(|e| AppError::crypto(format!("base64 解码失败: {e}")))
}
