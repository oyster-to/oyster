// "✦ Ask" pill. Sibling to NewSessionPill in the breadcrumb nav's
// right-aligned cluster. Opens the Ask Oyster slide-over panel.

export function AskPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="nsp-pill"
      onClick={onClick}
      title="Ask Oyster about your current scope"
    >
      <span aria-hidden="true">✦</span>
      <span>Ask</span>
    </button>
  );
}
