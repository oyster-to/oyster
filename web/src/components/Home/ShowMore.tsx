// "Show more" pager used under Sessions, Memories, and Artefacts sections.
// Extracted from Home/index.tsx. Optional keyboard hints surface the
// global shortcuts where they make sense (search anywhere; new-session
// in the Sessions section).
import { caps } from "../../caps";

export function ShowMore({
  onClick,
  remaining,
  searchHint = false,
  newSessionHint = false,
}: {
  onClick: () => void;
  remaining: number;
  searchHint?: boolean;
  newSessionHint?: boolean;
}) {
  return (
    <div className="home-show-more">
      <button type="button" className="home-memories-toggle" onClick={onClick}>
        Show more
      </button>
      <span className="home-show-more-hint">
        {remaining} more
        {caps.canChat && (
          <span className="home-more-hints">
            {searchHint && (
              <>
                {" · "}<kbd>⌘K</kbd> to search
              </>
            )}
            {newSessionHint && (
              <>
                {" · "}<kbd>⌘/</kbd> new session
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}
