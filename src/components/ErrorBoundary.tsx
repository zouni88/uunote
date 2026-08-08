import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/** 错误边界：子组件渲染异常时给出提示，避免整个应用崩溃白屏 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary 捕获异常:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="canvas-loading">
            画布加载失败，请刷新页面重试（详情见控制台）
          </div>
        )
      );
    }
    return this.props.children;
  }
}
