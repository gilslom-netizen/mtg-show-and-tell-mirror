import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

/**
 * What the screen does when a component throws.
 *
 * Nothing, until this existed — and "nothing" is the worst possible answer.
 * React 18 unmounts the whole tree when a render throws and there is no
 * boundary above it, so a single bad read in a single card left the player
 * looking at a blank white page in the middle of a game. No message, no board,
 * no clue what happened, and no way back except a reload that they had no
 * reason to think would help. That is what "the site crashed on me at random"
 * looks like from the outside, whatever the underlying bug turns out to be.
 *
 * A boundary cannot prevent the bug. What it can do is three things that are
 * each worth more than a white page: say that something broke, keep the way
 * back to the game visible, and put the actual error on screen where it can be
 * copied into a bug report instead of being lost with the tab.
 *
 * Trying again is offered first, and it is not wishful thinking: the game does
 * not live in React. The connection holds the engine (or the room on the
 * server), the store holds the views, and the tree is only a drawing of them —
 * so remounting redraws from state that is still perfectly good, and a crash
 * that depended on a transient board is usually gone by the time the player
 * presses the button.
 */

interface Props {
  children: ReactNode;
  /** Called by "Back to the lobby", to let go of the connection. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  /**
   * Bumped on every retry, to force a fresh subtree rather than a reused one.
   *
   * Carried by a keyed fragment rather than a wrapper element: `#root` is a
   * height:100% box and the app fills it, so an extra div between the two would
   * quietly collapse the board while claiming to fix a crash.
   */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where a player can be talked through finding it, and where
    // it survives the retry that is about to throw the component tree away.
    console.error('Something in the interface threw:', error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  private toLobby = (): void => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;

    return (
      <div className="lobby">
        <div className="lobby-card">
          <header className="lobby-head">
            <h1>Something in the interface broke</h1>
            <p>
              The game itself is still here — this is the screen that failed, not
              the board. Try drawing it again first; if it breaks the same way,
              going back to the lobby always works, and an online room can be
              rejoined from there with the game exactly where you left it.
            </p>
          </header>

          <div className="row">
            <button className="primary is-cta" onClick={this.retry}>
              Try that again
            </button>
            <button onClick={this.toLobby}>Back to the lobby</button>
            <button onClick={() => location.reload()}>Reload the page</button>
          </div>

          <details className="lobby-fold" open>
            <summary>What went wrong (worth copying into a bug report)</summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 11,
                maxHeight: 220,
                overflow: 'auto',
                margin: 0,
              }}
            >
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
