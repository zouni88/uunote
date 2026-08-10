import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
// TipTap v3 起 StarterKit 已内置 Link / Underline（直接在其 configure 里调整选项，勿重复注册）
// 表格扩展（含行/列/表头）统一从主包导出
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";

interface RichTextEditorProps {
  /** 富文本内容（HTML） */
  value: string;
  /** 内容变更（由父组件负责防抖保存） */
  onChange: (html: string) => void;
}

/**
 * 专业富文本编辑器（所见即所得）：标题/加粗/斜体/列表/引用/代码/表格/任务清单/图片/链接
 */
export default function RichTextEditor({ value, onChange }: RichTextEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const initialValueRef = useRef(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
        },
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
      }),
      Placeholder.configure({
        placeholder: "开始写作，支持标题、列表、表格、图片、任务清单等…",
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: "rt-content",
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // 外部 value 变化（切换笔记）时同步编辑器内容；避免覆盖用户正在编辑的内容
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML() && value !== initialValueRef.current) {
      initialValueRef.current = value;
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  if (!editor) return null;

  /** 工具栏按钮（带激活态） */
  const Btn = ({
    title,
    active,
    disabled,
    onClick,
    children,
  }: {
    title: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      className={`rt-tool-btn ${active ? "active" : ""}`}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );

  const insertImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      editor.chain().focus().setImage({ src: reader.result! }).run();
    };
    reader.readAsDataURL(file);
  };

  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("链接地址", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className="rt-editor">
      <div className="rt-toolbar">
        <Btn title="撤销" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
          ↶
        </Btn>
        <Btn title="重做" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
          ↷
        </Btn>
        <span className="rt-tool-sep" />
        <select
          className="rt-tool-select"
          title="标题样式"
          value={
            editor.isActive("heading", { level: 1 })
              ? "h1"
              : editor.isActive("heading", { level: 2 })
                ? "h2"
                : editor.isActive("heading", { level: 3 })
                  ? "h3"
                  : "p"
          }
          onChange={(e) => {
            const v = e.target.value;
            if (v === "p") editor.chain().focus().setParagraph().run();
            else
              editor
                .chain()
                .focus()
                .toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 })
                .run();
          }}
        >
          <option value="p">正文</option>
          <option value="h1">H1 标题</option>
          <option value="h2">H2 标题</option>
          <option value="h3">H3 标题</option>
        </select>
        <Btn title="加粗 (Ctrl+B)" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
          <b>B</b>
        </Btn>
        <Btn title="斜体 (Ctrl+I)" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <i>I</i>
        </Btn>
        <Btn title="下划线 (Ctrl+U)" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          <u>U</u>
        </Btn>
        <Btn title="删除线" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <s>S</s>
        </Btn>
        <Btn title="行内代码" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
          {"</>"}
        </Btn>
        <span className="rt-tool-sep" />
        <Btn title="无序列表" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          •列表
        </Btn>
        <Btn title="有序列表" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          1.列表
        </Btn>
        <Btn title="任务清单" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}>
          任务
        </Btn>
        <Btn title="引用" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          引用
        </Btn>
        <Btn title="代码块" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
          {"{ }"}
        </Btn>
        <span className="rt-tool-sep" />
        <Btn title="插入表格" active={editor.isActive("table")} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          表格
        </Btn>
        <Btn title="插入图片" onClick={() => fileRef.current?.click()}>
          图片
        </Btn>
        <Btn title="插入链接" active={editor.isActive("link")} onClick={setLink}>
          链接
        </Btn>
        <Btn title="分割线" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          分割线
        </Btn>
        <span className="rt-tool-sep rt-tool-flex" />
        <Btn title="清除格式" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
          清除格式
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={insertImage}
        />
      </div>

      {editor.isActive("table") && (
        <div className="rt-table-actions">
          <button onClick={() => editor.chain().focus().addRowBefore().run()}>上方加行</button>
          <button onClick={() => editor.chain().focus().addRowAfter().run()}>下方加行</button>
          <button onClick={() => editor.chain().focus().addColumnBefore().run()}>左侧加列</button>
          <button onClick={() => editor.chain().focus().addColumnAfter().run()}>右侧加列</button>
          <button onClick={() => editor.chain().focus().deleteRow().run()}>删除行</button>
          <button onClick={() => editor.chain().focus().deleteColumn().run()}>删除列</button>
          <button onClick={() => editor.chain().focus().toggleHeaderRow().run()}>表头行</button>
          <button onClick={() => editor.chain().focus().deleteTable().run()}>删除表格</button>
        </div>
      )}

      <div className="rt-body">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
