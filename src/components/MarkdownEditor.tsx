import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownEditorProps {
  /** Markdown 源码 */
  value: string;
  /** 内容变更（由父组件负责防抖保存） */
  onChange: (value: string) => void;
}

type ViewMode = "edit" | "split" | "preview";

/** 工具栏按钮（模块级组件，避免每次渲染重建类型导致按钮重复挂载） */
function ToolBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="md-tool-btn"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 专业 Markdown 编辑器：工具栏 + 源码编辑 / 分屏实时预览 / 纯预览
 * 支持 GFM（表格、任务清单、删除线、脚注等）
 *
 * 输入由组件本地 state 驱动，即时反映到源码与预览，不受父组件防抖保存节奏影响。
 */
export default function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const [view, setView] = useState<ViewMode>("split");
  // 本地文本状态：输入即时响应、预览实时更新
  const [text, setText] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 最近一次已提交给父组件的文本：用于区分"外部同步变更"和"自己提交后的回声"
  const lastEmittedRef = useRef(value);

  // 仅当外部 value 真正变化（且不是本组件提交的回声，如跨设备同步覆盖）时同步
  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      setText(value);
    }
  }, [value]);

  /** 更新文本：同步本地状态（即时显示/预览）+ 通知父组件保存 */
  const emit = (next: string) => {
    setText(next);
    lastEmittedRef.current = next;
    onChange(next);
  };

  /** 对选区包裹/替换 markdown 语法（未选中时插入默认内容并选中） */
  const wrapSelection = (before: string, after = "", placeholder = "") => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = text.slice(start, end) || placeholder;
    const next =
      text.slice(0, start) + before + selected + after + text.slice(end);
    emit(next);
    // 光标放到替换内容之后；若原来没有选中内容则选中占位符便于直接修改
    const selStart = start + before.length;
    const selEnd = selStart + selected.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(
        selected === placeholder ? selStart : selStart,
        selected === placeholder ? selStart + placeholder.length : selEnd,
      );
    });
  };

  /** 行首操作（标题/列表/引用/代码块等）：给选中的每一行加前缀 */
  const linePrefix = (prefix: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = (() => {
      const idx = text.indexOf("\n", end);
      return idx === -1 ? text.length : idx;
    })();
    const target = text.slice(start, end) || text.slice(lineStart, lineEnd);
    const replaced = target
      .split("\n")
      .map((l) => `${prefix}${l}`)
      .join("\n");
    const next = text.slice(0, lineStart) + replaced + text.slice(lineEnd);
    emit(next);
    const selStart = lineStart;
    const selEnd = lineStart + replaced.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
    });
  };

  const toggleBold = () => wrapSelection("**", "**", "加粗文字");
  const toggleItalic = () => wrapSelection("*", "*", "斜体文字");
  const toggleStrike = () => wrapSelection("~~", "~~", "删除线");
  const toggleInlineCode = () => wrapSelection("`", "`", "代码");
  const toggleLink = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = text.slice(start, end) || "链接文字";
    const next =
      text.slice(0, start) + `[${selected}](https://)` + text.slice(end);
    emit(next);
  };
  const insertTable = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const table =
      "| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |";
    const next = text.slice(0, start) + table + text.slice(start);
    emit(next);
  };

  const headings = [1, 2, 3].map((n) => () => linePrefix("#".repeat(n) + " "));

  // 预览基于本地 text，输入实时渲染
  const preview = useMemo(
    () => (
      <div className="md-preview">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer" />
            ),
            img: ({ node, ...props }) => (
              <img {...props} style={{ maxWidth: "100%" }} />
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    ),
    [text],
  );

  return (
    <div className="md-editor">
      <div className="md-toolbar">
        <ToolBtn title="加粗 (Ctrl+B)" onClick={toggleBold}>
          <b>B</b>
        </ToolBtn>
        <ToolBtn title="斜体 (Ctrl+I)" onClick={toggleItalic}>
          <i>I</i>
        </ToolBtn>
        <ToolBtn title="删除线" onClick={toggleStrike}>
          <s>S</s>
        </ToolBtn>
        <ToolBtn title="行内代码" onClick={toggleInlineCode}>
          <code>&lt;/&gt;</code>
        </ToolBtn>
        <span className="md-tool-sep" />
        <ToolBtn title="一级标题" onClick={headings[0]}>
          H1
        </ToolBtn>
        <ToolBtn title="二级标题" onClick={headings[1]}>
          H2
        </ToolBtn>
        <ToolBtn title="三级标题" onClick={headings[2]}>
          H3
        </ToolBtn>
        <ToolBtn title="引用" onClick={() => linePrefix("> ")}>
          引用
        </ToolBtn>
        <ToolBtn title="代码块" onClick={() => wrapSelection("```\n", "\n```", "代码")}>
          {"{ }"}
        </ToolBtn>
        <span className="md-tool-sep" />
        <ToolBtn title="无序列表" onClick={() => linePrefix("- ")}>
          •列表
        </ToolBtn>
        <ToolBtn title="有序列表" onClick={() => linePrefix("1. ")}>
          1.列表
        </ToolBtn>
        <ToolBtn title="任务清单" onClick={() => linePrefix("- [ ] ")}>
          任务
        </ToolBtn>
        <ToolBtn title="链接" onClick={toggleLink}>
          链接
        </ToolBtn>
        <ToolBtn title="插入表格" onClick={insertTable}>
          表格
        </ToolBtn>
        <span className="md-tool-sep md-tool-flex" />
        <div className="md-view-toggle">
          <button
            className={view === "edit" ? "active" : ""}
            onClick={() => setView("edit")}
          >
            编辑
          </button>
          <button
            className={view === "split" ? "active" : ""}
            onClick={() => setView("split")}
          >
            分屏
          </button>
          <button
            className={view === "preview" ? "active" : ""}
            onClick={() => setView("preview")}
          >
            预览
          </button>
        </div>
      </div>
      <div className={`md-body ${view}`}>
        {view !== "preview" && (
          <textarea
            ref={textareaRef}
            className="md-source"
            value={text}
            spellCheck={false}
            placeholder="开始写作，支持 Markdown 语法…"
            onChange={(e) => emit(e.target.value)}
            onKeyDown={(e) => {
              // Tab 键插入两个空格缩进
              if (e.key === "Tab") {
                e.preventDefault();
                const ta = e.currentTarget;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                emit(text.slice(0, start) + "  " + text.slice(end));
                requestAnimationFrame(() => {
                  ta.setSelectionRange(start + 2, start + 2);
                });
              }
            }}
          />
        )}
        {view !== "edit" && <div className="md-preview-wrap">{preview}</div>}
      </div>
    </div>
  );
}
