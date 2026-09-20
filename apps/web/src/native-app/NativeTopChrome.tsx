import type { ReactNode } from "react";

export interface NativeTopChromeProps {
  sidebarOpen: boolean;
  macDesktop?: boolean;
  isFullscreen?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onToggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  trailing?: ReactNode;
}

function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 22" focusable="false">
      <rect height="20" rx="5" width="22" x="1" y="1" />
      <rect
        fill="currentColor"
        height="14"
        rx={open ? "2.5" : "1"}
        width={open ? "5" : "2"}
        x="4"
        y="4"
      />
    </svg>
  );
}

function HistoryChevron({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d={direction === "back" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

export function NativeTopChrome({
  sidebarOpen,
  macDesktop = false,
  isFullscreen = false,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onGoBack,
  onGoForward,
  trailing
}: NativeTopChromeProps) {
  // Buzz clears the traffic-light band only while macOS controls are visible.
  // Electron's fullscreen event supplies the same state to this component.
  const macChrome = macDesktop && !isFullscreen;

  return (
    <header className={`native-top-chrome${macChrome ? " is-mac-desktop" : ""}`} aria-label="アプリナビゲーション">
      <div className="native-top-chrome-controls">
        <button
          type="button"
          className="native-top-chrome-button native-top-chrome-sidebar"
          aria-label={sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <SidebarIcon open={sidebarOpen} />
        </button>
        <button
          type="button"
          className="native-top-chrome-button native-top-chrome-history"
          aria-label="前の画面へ戻る"
          onClick={onGoBack}
          disabled={!canGoBack}
        >
          <HistoryChevron direction="back" />
        </button>
        <button
          type="button"
          className="native-top-chrome-button native-top-chrome-history"
          aria-label="次の画面へ進む"
          onClick={onGoForward}
          disabled={!canGoForward}
        >
          <HistoryChevron direction="forward" />
        </button>
      </div>
      <div className="native-top-chrome-drag-surface" aria-hidden="true" />
      {trailing ? <div className="native-top-chrome-trailing">{trailing}</div> : null}
    </header>
  );
}

export default NativeTopChrome;
