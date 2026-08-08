//! 极简全局事件总线：跨组件/页面通信（命令面板 → 页面跳转、打开指定记录）

type Handler = (payload?: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

export function on(event: string, fn: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(fn);
  return () => handlers.get(event)?.delete(fn);
}

export function emit(event: string, payload?: unknown): void {
  handlers.get(event)?.forEach((fn) => fn(payload));
}

/** 命令面板跳转目标（先存后发，页面挂载后消费，避免时序竞态） */
export interface NavigateTarget {
  page: "notes" | "accounts" | "documents" | "settings" | "about";
  noteId?: string;
  accountId?: string;
}

let pendingNavigate: NavigateTarget | null = null;

export function requestNavigate(target: NavigateTarget): void {
  pendingNavigate = target;
  emit("navigate", target);
}

export function consumePendingNavigate(): NavigateTarget | null {
  const t = pendingNavigate;
  pendingNavigate = null;
  return t;
}
