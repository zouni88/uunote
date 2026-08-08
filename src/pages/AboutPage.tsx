import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

const features: { title: string; desc: string }[] = [
  {
    title: "笔记（自由画布）",
    desc: "OneNote 式自由画布，文字、图片、手写涂鸦、表格可任意摆放，支持置顶与自动保存。",
  },
  {
    title: "账号（密码管理）",
    desc: "各类登录信息加密存储，密码可显示/隐藏，支持快速检索定位。",
  },
  {
    title: "重要资料（文件保险箱）",
    desc: "任意类型文件加密保存，导入时自动加密、导出时自动解密。",
  },
  {
    title: "GitHub 云同步（可选）",
    desc: "数据加密后同步到自己的 GitHub 私人仓库，云端只见密文，也可纯本地使用。",
  },
  {
    title: "端到端加密",
    desc: "Argon2id 密钥派生 + AES-256-GCM 加密，主密钥只存内存，从不写入磁盘。",
  },
  {
    title: "数据迁移",
    desc: "支持跨盘符迁移数据目录，不占用系统盘空间。",
  },
];

const stack: { name: string; value: string }[] = [
  { name: "桌面框架", value: "Tauri 2" },
  { name: "前端", value: "React + TypeScript + Vite" },
  { name: "后端", value: "Rust" },
  { name: "存储", value: "SQLite" },
  { name: "加密", value: "Argon2id + AES-256-GCM" },
  { name: "同步", value: "git2" },
  { name: "凭据存储", value: "Windows 凭据管理器" },
];

export default function AboutPage() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="page about-page">
      <div className="about-hero">
        <div className="about-logo">U</div>
        <h2>UUNote</h2>
        {version && <p className="about-version">版本 {version}</p>}
        <p className="about-slogan">
          本地加密的笔记 / 账号 / 重要资料管理工具，数据只属于你自己。
        </p>
      </div>

      <section className="about-section">
        <h3>关于 UUNote</h3>
        <p>
          UUNote 是一款完全本地运行的桌面笔记软件。所有数据——笔记、账号密码、重要资料文件——都保存在你自己的电脑上，
          不经过任何第三方服务器。可选地把加密后的数据同步到你的 GitHub 私人仓库，用于多设备备份，全程加密，云端看不到任何明文。
        </p>
      </section>

      <section className="about-section">
        <h3>功能特性</h3>
        <ul className="about-features">
          {features.map((f) => (
            <li key={f.title}>
              <div className="about-feature-title">{f.title}</div>
              <p>{f.desc}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="about-section">
        <h3>技术栈</h3>
        <div className="about-stack">
          {stack.map((s) => (
            <div key={s.name} className="about-stack-row">
              <span className="about-stack-name">{s.name}</span>
              <span>{s.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h3>许可证</h3>
        <p>
          UUNote 基于 Apache-2.0 协议开源，代码可审查、可自行构建。
        </p>
      </section>
    </div>
  );
}
