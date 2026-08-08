import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { changeMasterPassword, storageApi, syncApi } from "../api";
import type { SyncConfig } from "../types";

export default function SettingsPage() {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("main");
  const [gitProxy, setGitProxy] = useState("");
  const [tokenSaved, setTokenSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdMsg, setPwdMsg] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [moving, setMoving] = useState(false);
  const [storageMsg, setStorageMsg] = useState("");

  useEffect(() => {
    syncApi.config().then((cfg) => {
      if (cfg) {
        setConfig(cfg);
        setRepoUrl(cfg.repoUrl);
        setBranch(cfg.branch);
        if (cfg.gitProxy) setGitProxy(cfg.gitProxy);
        // Token 不回显明文，仅标记是否已保存
        setTokenSaved(!!cfg.hasToken);
      }
    });
    storageApi.getDir().then(setDataDir);
  }, []);

  /** 选择新存储位置并把数据迁移过去（数据库、加密资料、同步仓库） */
  async function chooseDataDir() {
    const dir = await open({ directory: true, title: "选择数据存储位置" });
    if (!dir || typeof dir !== "string") return;
    setMoving(true);
    setStorageMsg("正在迁移数据，请稍候…");
    try {
      const newPath = await storageApi.setDir(dir);
      setDataDir(newPath);
      setStorageMsg("数据已迁移到新位置，并会作为默认存储目录。");
    } catch (e) {
      setStorageMsg(`迁移失败：${e}`);
    } finally {
      setMoving(false);
    }
  }

  async function handleSave() {
    if (!repoUrl.trim() || (!token.trim() && !tokenSaved)) {
      setMessage("请填写仓库地址和 Token");
      return;
    }
    await syncApi.saveConfig(
      repoUrl.trim(),
      token.trim(),
      branch.trim() || "main",
      gitProxy.trim()
    );
    if (token.trim()) setTokenSaved(true);
    setMessage("配置已保存，正在自动同步…");
    try {
      // 保存后自动同步：远端为空仓库则自动初始化推送，否则自动拉取
      setMessage(await syncApi.auto());
    } catch (e) {
      setMessage(`配置已保存，但自动同步失败：${e}`);
    }
  }

  async function runPush() {
    setMessage("正在推送…");
    try {
      setMessage(await syncApi.push());
    } catch (e) {
      setMessage(`推送失败：${e}`);
    }
  }

  async function runPull() {
    setMessage("正在拉取…");
    try {
      setMessage(await syncApi.pull());
    } catch (e) {
      setMessage(`拉取失败：${e}`);
    }
  }

  async function handleChangePassword() {
    if (!oldPwd || !newPwd) {
      setPwdMsg("请填写原密码和新密码");
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdMsg("两次输入的新密码不一致");
      return;
    }
    try {
      await changeMasterPassword(oldPwd, newPwd);
      setPwdMsg("主密码已修改，本地数据已用新密码重新加密。");
      setOldPwd("");
      setNewPwd("");
      setConfirmPwd("");
    } catch (e) {
      setPwdMsg(`修改失败：${e}`);
    }
  }

  return (
    <div className="page settings-page">
      <h2>设置</h2>

      <section className="settings-section">
        <h3>数据存储位置</h3>
        <p className="settings-hint">
          所有数据（数据库、加密资料、同步仓库）默认保存在系统盘（C
          盘）。可更改到其它磁盘，避免占用系统盘空间。
        </p>
        <div className="form-field">
          <label>当前数据目录</label>
          <div className="storage-path">{dataDir || "加载中…"}</div>
        </div>
        <div className="form-actions">
          <button onClick={chooseDataDir} disabled={moving}>
            {moving ? "迁移中…" : "选择新位置"}
          </button>
        </div>
        <p className="settings-hint">
          迁移会将现有数据一并移动到新目录（支持跨盘符），完成后立即生效；新目录需为空。
        </p>
        {storageMsg && <p className="sync-message">{storageMsg}</p>}
      </section>

      <section className="settings-section">
        <h3>GitHub 云同步</h3>
        <p className="settings-hint">
          数据将加密后自动保存到你的 GitHub 私人仓库，无需自建服务器。
        </p>
        <div className="form-field">
          <label>仓库地址</label>
          <input
            value={repoUrl}
            placeholder="https://github.com/用户名/仓库名.git"
            onChange={(e) => setRepoUrl(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Personal Access Token</label>
          <input
            type="password"
            value={token}
            placeholder={tokenSaved ? "已保存（留空保持不变）" : "GitHub Settings → Developer settings → Tokens"}
            onChange={(e) => setToken(e.target.value)}
          />
          {tokenSaved && (
            <p className="settings-hint">Token 已保存，无需重复填写；如需更换，输入新 Token 后保存即可。</p>
          )}
        </div>
        <div className="form-field">
          <label>分支</label>
          <input
            value={branch}
            placeholder="main"
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Git 代理（可选）</label>
          <input
            value={gitProxy}
            placeholder="如 http://127.0.0.1:7890（Clash 等代理软件地址）"
            onChange={(e) => setGitProxy(e.target.value)}
          />
          <p className="settings-hint">
            留空会自动使用 Windows 系统代理（Clash「系统代理」模式），无需填写；仅当需要指定其它代理时才填写。
          </p>
        </div>
        <div className="form-actions">
          <button className="primary" onClick={handleSave}>保存配置</button>
          <button onClick={runPull}>拉取</button>
          <button onClick={runPush}>推送</button>
        </div>
        {message && <p className="sync-message">{message}</p>}
        {config?.lastSyncAt && (
          <p className="sync-message">上次同步：{new Date(config.lastSyncAt).toLocaleString()}</p>
        )}
      </section>

      <section className="settings-section">
        <h3>修改主密码</h3>
        <p className="settings-hint">
          修改后本地全部数据（账号密码、加密资料）会用新密码重新加密，之后请用新密码解锁。
        </p>
        <div className="form-field">
          <label>原密码</label>
          <input
            type="password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>新密码</label>
          <input
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>确认新密码</label>
          <input
            type="password"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
          />
        </div>
        <div className="form-actions">
          <button onClick={handleChangePassword}>修改主密码</button>
        </div>
        {pwdMsg && <p className="sync-message">{pwdMsg}</p>}
      </section>
    </div>
  );
}
