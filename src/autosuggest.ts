// Terminal command autosuggest, fish-shell style: as you type at the prompt, the most recent
// matching command from history appears as dim "ghost" text; Tab / → / End accepts it, sending the
// remaining characters to the shell.
//
// PRIVACY: everything here is local. Captured history lives only on this machine (it is kept out of
// the settings/backup bundle in App.tsx) and is never sent to the sshache backend. This keeps the
// zero-knowledge invariant intact (see CLAUDE.md).
//
// We don't own the remote shell, so the "current line" is reconstructed from the keystrokes we
// forward (applyKey below). That is a heuristic: line-editing we can't observe (↑/↓ history recall,
// Tab completion) sets `blocked`, which just suppresses the ghost until the next Enter. The failure
// mode is "no suggestion", never a wrong command injected.

// ---- history --------------------------------------------------------------

// Most-recent-first, de-duplicated command history with a hard cap.
export class History {
  private items: string[] = [];
  constructor(
    private max = 1000,
    seed?: string[],
  ) {
    // seed is newest-first (the shape toJSON() emits), so persistence round-trips: add oldest
    // first and newest last so the newest lands back at the front.
    if (seed) for (let i = seed.length - 1; i >= 0; i--) this.add(seed[i]);
  }
  add(raw: string): void {
    const c = raw.trim();
    if (c.length < 2) return; // skip single-char noise
    const i = this.items.indexOf(c);
    if (i !== -1) this.items.splice(i, 1); // de-dupe: move existing entry to the front
    this.items.unshift(c);
    if (this.items.length > this.max) this.items.length = this.max;
  }
  // Most-recent command that starts with `prefix` and is strictly longer.
  suggest(prefix: string): string | null {
    if (!prefix) return null;
    for (const c of this.items) if (c.length > prefix.length && c.startsWith(prefix)) return c;
    return null;
  }
  toJSON(): string[] {
    return this.items;
  }
}

// Parse raw shell-history file text (bash or zsh) into commands, oldest→newest, cleaned and capped
// to the most recent `max`. Handles zsh EXTENDED_HISTORY (": <start>:<elapsed>;cmd") and bash
// timestamp comment lines (#1699999999). Used to seed history from a remote host on connect.
export function parseShellHistory(raw: string, max = 2000): string[] {
  const out: string[] = [];
  for (const rawLine of raw.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) continue; // blank / bash timestamp comment
    const m = line.match(/^: \d+:\d+;(.*)$/); // zsh extended history prefix
    if (m) line = m[1];
    const cmd = line.trim();
    if (cmd.length >= 2) out.push(cmd);
  }
  return out.length > max ? out.slice(-max) : out;
}

// ---- line reconstruction (pure, so it is trivially testable) --------------

export interface LineState {
  line: string;
  pos: number;
  blocked: boolean;
}
export const emptyLine = (): LineState => ({ line: '', pos: 0, blocked: false });

// Fold one chunk of forwarded keystrokes into the reconstructed line. Returns the next state and,
// when Enter was pressed, the completed command in `recorded`.
export function applyKey(s: LineState, d: string): { state: LineState; recorded?: string } {
  let { line, pos, blocked } = s;
  let recorded: string | undefined;

  // Escape sequences arrive as one chunk per keypress and never appear inside pasted text, so we
  // match the whole chunk rather than sub-parsing.
  if (d.charCodeAt(0) === 0x1b) {
    if (d === '\x1b[C') pos = Math.min(pos + 1, line.length); // →
    else if (d === '\x1b[D') pos = Math.max(pos - 1, 0); // ←
    else if (d === '\x1b[H' || d === '\x1bOH' || d === '\x1b[1~') pos = 0; // Home
    else if (d === '\x1b[F' || d === '\x1bOF' || d === '\x1b[4~') pos = line.length; // End
    else if (d === '\x1b[3~') line = line.slice(0, pos) + line.slice(pos + 1); // Delete
    else blocked = true; // ↑/↓ history recall, Alt-edits, unknown → can't track, suppress
    return { state: { line, pos, blocked } };
  }

  for (const ch of d) {
    const code = ch.charCodeAt(0);
    if (code === 0x0d || code === 0x0a) {
      // Enter
      if (line.trim()) recorded = line.trim();
      line = '';
      pos = 0;
      blocked = false;
    } else if (code === 0x7f || code === 0x08) {
      // Backspace
      if (pos > 0) {
        line = line.slice(0, pos - 1) + line.slice(pos);
        pos--;
      }
    } else if (code === 0x03) {
      // Ctrl-C
      line = '';
      pos = 0;
      blocked = false;
    } else if (code === 0x15) {
      // Ctrl-U — kill to line start (approx; some shells kill the whole line)
      line = line.slice(pos);
      pos = 0;
    } else if (code === 0x0b) {
      // Ctrl-K — kill to end
      line = line.slice(0, pos);
    } else if (code === 0x01) {
      pos = 0; // Ctrl-A
    } else if (code === 0x05) {
      pos = line.length; // Ctrl-E
    } else if (code === 0x17) {
      // Ctrl-W — delete word before cursor
      let i = pos;
      while (i > 0 && line[i - 1] === ' ') i--;
      while (i > 0 && line[i - 1] !== ' ') i--;
      line = line.slice(0, i) + line.slice(pos);
      pos = i;
    } else if (code === 0x09) {
      blocked = true; // Tab → shell completion rewrites the line
    } else if (code < 0x20) {
      blocked = true; // other control bytes → suppress to stay safe
    } else {
      line = line.slice(0, pos) + ch + line.slice(pos); // printable insert
      pos++;
    }
  }
  return { state: { line, pos, blocked }, recorded };
}

// True when `d` is the "accept the suggestion" gesture (Tab, →, or End). Tab is only treated as
// accept while a ghost is showing (see onData); with no ghost it falls through to shell completion.
export function isAcceptKey(d: string): boolean {
  return d === '\t' || d === '\x1b[C' || d === '\x1b[F' || d === '\x1bOF' || d === '\x1b[4~';
}

// ---- xterm controller -----------------------------------------------------

export interface SuggestHooks {
  send: (data: string) => void; // forward keystrokes to the shell (already routes broadcast)
  suggest: (prefix: string) => string | null; // instant history lookup
  record: (cmd: string) => void; // called on Enter with the completed command
  cfg: () => { on: boolean; color: string }; // live config accessor
}

// Wire autosuggest onto a live xterm. Installs the single term.onData input pipe (forwarding via
// hooks.send) and manages the ghost overlay. Returns a dispose().
export function attachAutosuggest(term: any, mount: HTMLElement, hooks: SuggestHooks): { dispose: () => void } {
  let s = emptyLine();
  let ghost = ''; // full suggested command, or '' when nothing is shown

  const overlay = document.createElement('span');
  Object.assign(overlay.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    whiteSpace: 'pre',
    pointerEvents: 'none',
    opacity: '0.42',
    zIndex: '10',
    display: 'none',
  } as CSSStyleDeclaration);
  const screen = () => mount.querySelector('.xterm-screen') as HTMLElement | null;
  const sc = screen();
  if (sc) sc.appendChild(overlay);

  // Position the ghost at the terminal's *real* cursor (which sits just after the echoed input),
  // so we don't have to guess the prompt width or fight echo timing.
  const place = () => {
    const el = screen();
    if (!ghost || !el) {
      overlay.style.display = 'none';
      return;
    }
    const cols = term.cols || 80,
      rows = term.rows || 24;
    const cw = el.clientWidth / cols,
      ch = el.clientHeight / rows;
    const b = term.buffer.active;
    const cx = b.cursorX,
      cy = b.cursorY; // viewport-relative
    let suffix = ghost.slice(s.line.length);
    const room = cols - cx;
    if (suffix.length > room) suffix = suffix.slice(0, Math.max(0, room)); // clip to the row
    if (!suffix) {
      overlay.style.display = 'none';
      return;
    }
    const c = hooks.cfg();
    overlay.textContent = suffix;
    overlay.style.color = c.color;
    overlay.style.fontFamily = term.options.fontFamily;
    overlay.style.fontSize = (term.options.fontSize || 13) + 'px';
    overlay.style.left = cx * cw + 'px';
    overlay.style.top = cy * ch + 'px';
    overlay.style.height = ch + 'px';
    overlay.style.lineHeight = ch + 'px';
    overlay.style.display = 'block';
  };

  const setGhost = (full: string) => {
    ghost = full;
    place();
  };

  // Read a viewport row (0 = top of the visible area) as plain text, trailing space trimmed.
  const readRow = (vy: number): string => {
    try {
      const b = term.buffer.active;
      const ln = b.getLine(b.baseY + vy);
      return ln ? ln.translateToString(true) : '';
    } catch {
      return '';
    }
  };

  // SECURITY-CRITICAL: true only when `text` is actually visible on the current row. At a no-echo
  // prompt (password, `sudo`, `ssh` passphrase) the typed characters are invisible, so this is
  // false and we neither ghost nor record them — secrets never enter history.
  const shownOnRow = (text: string): boolean => {
    if (!text) return false;
    const b = term.buffer.active;
    return readRow(b.cursorY).includes(text);
  };
  // For the ghost we need the typed prefix to be echoed right up to the cursor.
  const typedVisible = (): boolean => {
    if (!s.line) return false;
    const b = term.buffer.active;
    const n = Math.min(s.line.length, b.cursorX);
    if (n <= 0) return false;
    const upTo = readRow(b.cursorY).slice(0, b.cursorX);
    return upTo.endsWith(s.line.slice(s.line.length - n));
  };

  const recompute = () => {
    const c = hooks.cfg();
    // Only suggest at end-of-line, when tracking is trustworthy and the feature is on.
    if (!c.on || s.blocked || s.pos !== s.line.length || s.line.length === 0 || !typedVisible()) {
      setGhost(''); // off / mid-line / no-echo prompt / buffer disagrees → stay silent
      return;
    }
    const hit = hooks.suggest(s.line);
    setGhost(hit && hit.startsWith(s.line) ? hit : '');
  };

  const onData = (d: string) => {
    // Accept the ghost with Tab / → / End when one is showing and the cursor is at the end.
    // (Tab only lands here while a ghost shows; otherwise it falls through to shell completion.)
    if (ghost && s.pos === s.line.length && isAcceptKey(d)) {
      const suffix = ghost.slice(s.line.length);
      hooks.send(suffix); // type the rest into the shell
      s = { line: ghost, pos: ghost.length, blocked: false }; // our model now matches the shell
      setGhost('');
      recompute(); // maybe chain a longer suggestion
      return;
    }
    // Enter: decide recording from the screen BEFORE forwarding, while the typed command is still
    // fully echoed on the current row. This is the one reliable moment — a no-echo prompt fails
    // the check, so passwords are never recorded. (Pastes containing newlines fall through to the
    // tracker and are intentionally not recorded.)
    if (d === '\r' || d === '\n') {
      const cmd = s.line.trim();
      const ok = cmd.length >= 2 && !s.blocked && shownOnRow(cmd);
      hooks.send(d);
      s = emptyLine();
      setGhost('');
      if (ok) hooks.record(cmd);
      return;
    }
    hooks.send(d);
    s = applyKey(s, d).state;
    recompute();
  };

  const subs = [
    term.onData(onData),
    term.onCursorMove(recompute), // fires after the shell echoes, so typedVisible() sees fresh text
    term.onRender(place),
    term.onScroll(place),
    term.onResize(place),
  ];

  return {
    dispose() {
      for (const sub of subs) {
        try {
          sub.dispose();
        } catch {
          /* ignore */
        }
      }
      try {
        overlay.remove();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---- self-check (pure logic) ----------------------------------------------
// ponytail: this repo has no test runner (verification is `npm run build` + manual), so instead of
// adding a framework this is a dependency-free check runnable with `npx tsx src/autosuggest.ts`.
// It exercises the two non-trivial pure pieces: history de-dupe/prefix and the key reducer.
export function selfCheckAutosuggest(): void {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error('autosuggest self-check failed: ' + msg);
  };

  // seed is newest-first: 'git status' is the most recent command.
  const h = new History(100, ['git status', 'git commit -m x', 'ls -la']);
  assert(h.suggest('git ') === 'git status', 'most-recent prefix match wins');
  assert(h.suggest('git c') === 'git commit -m x', 'older prefix match still found');
  assert(h.suggest('ls') === 'ls -la', 'prefix match');
  assert(h.suggest('zzz') === null, 'no match → null');
  h.add('git commit -m y'); // new most-recent
  assert(h.suggest('git c') === 'git commit -m y', 're-add promotes to most-recent');
  assert(h.suggest('git status') === null, 'no strictly-longer match → null');

  // type "gi", backspace, type "it s", Enter
  let st = emptyLine();
  for (const d of ['g', 'i']) st = applyKey(st, d).state;
  assert(st.line === 'gi' && st.pos === 2, 'typing builds the line');
  st = applyKey(st, '\x7f').state; // backspace
  assert(st.line === 'g' && st.pos === 1, 'backspace shortens');
  for (const d of ['i', 't', ' ', 's']) st = applyKey(st, d).state;
  const enter = applyKey(st, '\r');
  assert(enter.recorded === 'git s', 'Enter records the completed command');
  assert(enter.state.line === '' && enter.state.pos === 0, 'Enter clears the line');

  // ↑ (history recall) blocks tracking until the next Enter
  const blk = applyKey(emptyLine(), '\x1b[A');
  assert(blk.state.blocked === true, 'up-arrow blocks tracking');

  // mid-line insert
  let mid = emptyLine();
  for (const d of ['a', 'c']) mid = applyKey(mid, d).state;
  mid = applyKey(mid, '\x1b[D').state; // ← between a and c
  mid = applyKey(mid, 'b').state;
  assert(mid.line === 'abc' && mid.pos === 2, 'insert at cursor position');

  assert(isAcceptKey('\x1b[C') && isAcceptKey('\t') && !isAcceptKey('x'), 'accept-key detection');

  // shell history parsing: bash lines, zsh extended-history, bash timestamp comments, short-line drop
  const hp = parseShellHistory(['ls -la', '#1699999999', ': 1699999999:0;git status', '', 'x', 'docker ps'].join('\n'));
  assert(hp.length === 3 && hp[0] === 'ls -la' && hp[1] === 'git status' && hp[2] === 'docker ps', 'parseShellHistory cleans bash+zsh');
  // eslint-disable-next-line no-console
  console.log('autosuggest self-check OK');
}

// Run the self-check when executed directly (tsx/node), not when imported by the app.
// @ts-ignore - import.meta.url is available under the bundler/tsx
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  selfCheckAutosuggest();
}
