# Games roadmap

Users asked for games in the rooms, and **Draw & Guess** was the one requested by name and
seconded by others. Nothing here is built yet; this file records what was chosen, why, what each
option costs, and what still needs a decision.

Licences below were checked through the GitHub API on 2026-11-14 (`license.spdx_id`), not from
memory. Anything marked NOASSERTION is treated as unusable until proven otherwise.

## The constraints that decide what can be added

- **No build step, no frameworks.** Plain JS, static files in `public/`, one client file
  (`public/multi-room.js`), mobile-first from 390 px up. A game that arrives as a React app or a
  webpack bundle is out, however good it is.
- **One Durable Object per site** (`worker/hub.js`) relays every room's socket traffic and already
  holds per-room in-memory state (see `this.roomCalls` for the pattern). Anything turn-based or
  timed belongs there, not in a new service.
- **Budgets are real.** `MESSAGE_DAILY_CAP` (1000/user/day) and `MESSAGE_LIMIT_PER_WINDOW` (20 per
  10 s) exist because the free tier meters rows written. Game traffic must be a separate event type
  with its own limit, never chat messages, and high-frequency things (pen strokes) must be batched
  (one event per ~50 ms per stroke, capped) or they will read as spam.
- **Server validates, client renders.** A client-validated board is a board people win with the
  console open. Moves are checked and applied in the DO, then broadcast.

## The list, in build order

| # | Game | Players | Dependency (licence) | Server work | Rough size |
|---|---|---|---|---|---|
| 1 | **Draw & Guess** | 3–8 + spectators | `steveruizok/perfect-freehand` (MIT) | rounds, word choice, guess checking, scoring, stroke relay | large |
| 2 | **Connect Four** | 2 + spectators | none | turn state, move validation, win check | small |
| 3 | **Tic-tac-toe / dots & boxes** | 2 | none | same engine as Connect Four | trivial on top of #2 |
| 4 | **Chess** | 2 | `jhlywa/chess.js` (BSD-2-Clause), `shaack/cm-chessboard` (MIT) | legal-move validation, clocks, draw offers | medium |
| 5 | **2048**, **Sudoku** | solo | `gabrielecirulli/2048` (MIT), `robatron/sudoku.js` (MIT) | none — static pages | tiny |
| 6 | **Poker (Texas hold'em, no money)** | 2–6 | `goldfire/pokersolver` (MIT) | server-side shuffle, blinds, pots, showdown | large |
| 7 | **Trivia** | 2–8 | Open Trivia DB (CC BY-SA 4.0 — attribution required, verify before shipping) | question pacing, scoring | medium |

### 1. Draw & Guess (requested)

The most chat-native of the lot: the room's own chat already carries the guesses, so it needs no new
social surface, only a canvas and a round clock.

- **Flow:** a player starts a game in a room → everyone in the room sees an invite → the DO picks a
  drawer and a word from a bundled list → the drawer draws, everyone else types guesses in the room →
  a correct guess scores for the guesser and the drawer, the word is masked in the transcript until
  the round ends → 3–5 rounds, then a scoreboard.
- **Word list:** bundle a curated subset, not a dump. `dwyl/english-words` is **Unlicense** (public
  domain, 479k words) and is the safe source; filter it by length and by the site's 18+ but
  chat-safe tone, and keep the file in `public/` or `worker/lib/` — never fetch a word list at
  runtime.
- **Strokes:** batched points per stroke, a fixed-point encoding, and a cap per second. Redraw the
  whole canvas from state on rejoin/reconnect rather than replaying a stream.
- **Guess checking** happens in the DO (normalise, compare, don't echo the word). The masked word
  goes to the room as a separate field so a clever client cannot read it.
- **Why it is first anyway:** it shares 80% of the plumbing with the turn-based games, and it is the
  one the users actually asked for. Building the shared dock around the hardest case is more work
  than starting with Connect Four — worth it if this is what people will play.

### 2–3. Connect Four, then tic-tac-toe

Zero dependencies, and the smallest way to prove the plumbing end to end: room game state, invite,
turn enforcement, win detection, spectators, reconnect. Once this exists, tic-tac-toe and dots &
boxes are almost free.

### 4. Chess

`chess.js` for rules (legal moves, check/checkmate, FEN) with `cm-chessboard` for the board; both are
single-file modules that can be vendored into `public/vendor/` without a build. Send FEN + move in
events; the DO keeps authoritative state. Clocks and draw offers are the extra work.

### 5. Solo arcade pages

`2048` is MIT and ships as plain JS/HTML — a straight drop into `public/` with a menu link, no
Worker, D1 or rate-limit involvement. Sudoku (generator only, MIT) is the same shape. This is how a
game lands on the site in an afternoon, and it carries no cheat surface.

### 6. Poker

Only worth it with real demand. The parts that matter are server-side: shuffle inside the DO, deal
privately per socket, validate every action, resolve the pot with `pokersolver`. No money, ever.

### 7. Trivia

Open questions (CC BY-SA 4.0) need visible attribution, or write the questions ourselves. Pacing and
scoring are simple; the DO owns the current question.

## Explicitly not usable

- `lichess-org/lila` — **AGPL-3.0**. Network use obliges publishing the whole server, and it is a
  Scala monolith that would replace the Worker.
- `niklasf/chessground` — **GPL-3.0** board (what Lichess itself uses).
- `nmrugg/stockfish.js` — **GPL-3.0** and multi-megabyte wasm; only for a bot opponent, and only if
  copyleft is acceptable.
- `hextris/hextris` — **NOASSERTION**; terms unclear.
- React/TypeScript projects that need a build (`react-wordle` clones, `boardgame.io`, Excalidraw).
  `boardgame.io` would also duplicate the DO's networking.
- Word lists with unclear terms: `first20hours/google-10000-english` is **NOASSERTION**. Use
  `dwyl/english-words` (Unlicense).
- Any sprite, icon or sound pack without an explicit CC0/MIT license. `kenney.nl` is the safe source.

## Settled decisions (owner, 2026-11-14)

1. **Every room can host every game.** There is no dedicated games room in the sense of a chat room:
   games belong to the room they were started in.
2. **Games are hidden by default.** A room shows a **Games** control; the list only appears when it is
   opened. Nothing pops up or auto-opens on entry.
3. **A "Games" entry in the room list is the global view** — every game being played in every room,
   with **Watch**, **Join** (when the game is open) and **Request to join** (when the host reserves a
   seat).
4. **Join policies:** a game is either **open** (anyone may take a free seat) or **by request** (the
   host approves). Watching is always allowed, including for solo games, where watching is the only
   option.
5. **Anyone can start a game**, in any room they are in.
6. **Draw & Guess:** words are safe/clean for now. Spectators may guess, their guesses count, and a
   correct one is announced in the room as "<name> guessed the word". Guests' points are kept
   separately from players' points, and the end-of-game scoreboard shows both so spectators can see
   who scored best among themselves.
7. **Chess is human vs human only.** No engine, so no `stockfish.js` (GPL-3.0) and no wasm payload.

## Data model (draft, one game per room at a time)

Room game state is held on the Durable Object and copied to its storage under the key `roomGames`
(a plain `{roomId: game}`, rewritten whenever seats, board or status change). Memory alone was not
enough: WebSocket hibernation clears in-memory fields while sockets stay open, so a board people were
staring at would vanish between two moves. Spectators are dropped when the state is loaded, because
they belong to connections rather than to the game.

```
game = {
  id, kind, roomId, hostId,
  policy: "open" | "request",
  status: "lobby" | "playing" | "ended",
  seats:  { min, max },                    // Connect Four 2, Draw & Guess 3-8, solo 1
  players: [{ id, username, role, score }],
  guests:  [{ id, username, score }],      // spectators; scored separately
  pending: [{ id, username }],             // join requests waiting on the host
  turn: playerId | null,
  round: { number, drawerId, wordMask, endsAt } | null,
  board: {},                               // per-game payload, server-authoritative
  startedAt, endedAt
}
```

Socket events, all in the existing room channel: `game-list`, `game-create`, `game-join`,
`game-request`, `game-approve`, `game-deny`, `game-leave`, `game-watch`, `game-move`, `game-guess`,
`game-state`, `game-end`. Everything that changes state is validated in the DO and then broadcast as
`game-state`; clients never compute a legal move themselves.

Rate limiting: game events use their own `rateLimited()` key so a game never eats `MESSAGE_DAILY_CAP`
or `MESSAGE_LIMIT_PER_WINDOW`. Drawn strokes are batched (one event per ~50 ms per stroke, capped
per second) and are never stored per point.

## UI surfaces

- **In a room:** a **Games** button beside the existing actions opens the room's games in a panel
  **beside the chat, never over it** (owner's rule, 2026-11-16: people play while they talk). The split
  is **60% conversation / 40% game**: two columns from 860px up, the same ratio stacked vertically on a
  phone, because a side-by-side split at 390px leaves about 230px of chat. The panel carries the player
  list, seats, host approve / deny controls, the scoreboard and the spectator count, and a **⤢** toggle
  gives the board the whole room for a move without changing the default. Boards are sized from the
  panel's own height (container query units), so nothing hangs off the bottom of a 40% panel.
  **Draw & Guess is the exception on a phone:** below 700px it opens maximised (once per game, and the
  player's own ⤢ toggle wins from then on), because a drawing needs more than 40% of a 390px screen to be
  playable — in a 40% pane the canvas measured 51×39 px. The canvas also has a minimum size instead of
  shrinking to fit, and its Clear control lives in the header so it never needs a sideways scroll.
- **Room list:** a **Games** card above the room grid showing every live game across rooms with its
  room, game, seats taken and the three actions. It opens the all-games **modal**, which stays a modal
  because it is a directory across rooms rather than a game in the room you are in. It is the only place
  games are discoverable without opening a room, which is what "hidden by default" means.
- **Guesses** stay in the room chat (that is where the fun is), with the word masked in the transcript
  until the round ends and a system line when someone gets it.

## Build plan

1. **Dock + Connect Four.** ✅ `v=78`.
2. **Several games per room, the count on the room's Games button, and a Games entry in the room
   list.** ✅ `v=80` — a room holds up to four games at once, the button shows how many are running,
   and the room list begins with a Games card whose badge is the live total.
3. **Tic-tac-toe and Reversi.** ✅ `v=80` — both grid games, validated in the object like Connect Four.
4. **Fix pass after the first people played.** ✅ `v=82` — the cap counts running games only, finished
   boards are pruned, the host role moves to whoever is left, either player can rematch, and the object
   hands the dock the legal moves. Covered by `tests/games.js` (sockets) and `tests/games-ui.js` (two
   browsers through the dock).
5. **Restart belongs to a result, and empty boards clear.** ✅ `v=83` — the rematch lives on the board
   screen under a result line (who won, or it's a tie) and a board still in play cannot be restarted at
   all; a game whose last player leaves clears itself. `v=84`: a seat is never counted as a spectator.
   `v=85`: no history at all — a finished board is never listed and clears itself after
   `ENDED_GAME_TTL_MS` (two minutes, `--var` overridable).
6. **Draw & Guess.** ✅ `v=96` — three rounds, everybody draws once per round, 80 seconds a turn, three words
   offered with 15 seconds to choose (the first one is taken for a drawer who never answers). Guesses are typed
   into the **ordinary chat box**: any sentence containing the word counts, it scores the guesser and 50 to the
   drawer, and that message becomes the highlighted "xyz guessed the word" line instead of being posted. Guests
   score on their own list. A stroke is one event with its points batched and capped at 200. Details below.
7. **Chess** (`chess.js` BSD-2), human only, with clocks and draw offers. ✅ `v=95` — the object holds the
   position in FEN and every rule is chess.js's: castling, en passant, promotion, check, mate, stalemate,
   threefold, the 50-move draw. **Five minutes per side, no increment**, a clock that runs out loses on time
   (the alarm ends it even if nobody clicks), draw offers must be offered and accepted, resigning is its own
   action, and a rematch swaps colours because white always moves first. The panel draws the board from the
   server's board array (no chess library on the client) and marks the legal squares for the side to move.
   Covered by `tests/chess.js` (25 checks) and the chess part of the panel behaviour in `tests/games-ui.js`.
8. **Solo arcade** (2048 MIT, sudoku MIT) served as static pages. ✅ `v=94` — `public/arcade-2048.html` and
   `public/arcade-sudoku.html`, reachable from the Games panel and the all-games list. They are static on
   purpose (see "As built"): nothing to validate, nothing to watch, no Worker, D1 or rate-limit
   involvement, and the sudoku generator proves uniqueness with its own solver before showing a puzzle.
9. **Poker / trivia** only if demand appears.

## As built (`v=85`, three games)

Everything below is what the code actually does, not the plan it came from:

- **State** lives on the DO and is persisted under the storage key `roomGames`, so a game survives
  hibernation and a restart (verified by killing the dev server between a create and a move). It is a
  map of rooms to maps of games: **a room may run up to `GAMES_PER_ROOM` (4) games at once**, and one
  person may hold a seat in only one unfinished game per room, so nobody plays two boards at once.
- **A slot belongs to an unfinished game, and there is no history.** The cap counts games still in the
  lobby or being played, never finished boards: four dead boards at the cap used to close a room to new
  games for good, which is exactly what stranded a player whose host had walked off. A finished board is
  never listed either — the room's games are the games being played. It stays on the screen of whoever
  is looking at it (with the result and the rematch) and clears itself after `ENDED_GAME_TTL_MS` (two
  minutes), or the moment its last player leaves. The dock's "Start another game" follows the same rule,
  so it never disappears because of a result.
- **Games:** Connect Four (7x6 columns), Tic-tac-toe (3x3), Reversi (8x8, standard opening, with the
  pass rule when the opponent has no legal move). `GAME_KINDS` carries the layout; the client renders
  either a column board or a square grid from `layout`.
- **Privacy:** a game is listed only to accounts that may enter its room. What a request-only room is
  playing is not visible from outside it (owner's rule).
- **The dock asks for the truth** with a `game-sync` event when it opens, so a stale or just-restored
  view can never say "nobody is playing here" while a game exists.
- **Seats** come from `GAME_KINDS` (2 for all three). The host takes the first seat when creating.
  `policy: "open"` fills the seat on `game-join`; `policy: "request"` puts the person in `pending` and
  notifies the host, who approves or denies from the dock. Moderators and the admin can cover.
- **Refusals carry a sentence** in a `game-error` event: not your turn, only players may move, that
  column/square is off the board or occupied, a Reversi move that flips nothing, the game already
  started, only the host can do that, you are already playing here.
- **Boards** are one flat array each (`index = column * rows + row` for Connect Four, row-major for the
  grids). A move is validated against the kind's rules in the object; the client only reads state.
- **Leaving and abandonment:** pressing Leave on a running game forfeits it (the other player wins,
  `reason: "left"`); leaving a lobby game the host created closes it. Closing the tab is not leaving:
  the seat is held, the player is marked away, and only after `AWAY_GRACE_MS` (45 s in production,
  `--var` overridable) does the object settle it — a running game goes to whoever stayed, a lobby game
  whose host is gone disappears. The alarm does that on its own, and any game event sweeps first, so a
  returning player never loses a seat to a reload.
- **Restart, rematch and clearing:** a rematch only ever follows a result, and it lives on the board
  screen: the board says who won (or that it was a tie) and the Rematch button sits under that line. Either
  player may ask for it (`game-restart`: fresh board, same seats, the opening seat alternates so nobody is
  permanently the second player), and any of them may clear the board from the room, which it would do by
  itself shortly anyway. A board that is *still in play* has no result to restart from, so it is ended
  first (`game-end`) — a half-played position is never wiped by a stray tap. A rematch only seats the
  people still in the room: the seat of a player who walked out is dropped and the board reopens in the
  lobby rather than restarting against a ghost who never moves.
- **A board nobody is at clears itself.** When the last seated player leaves (pressing Leave, or closing
  the tab past the grace) the game is dropped instead of being kept as furniture, a finished board also
  clears itself after `ENDED_GAME_TTL_MS`, and a stored game with no seats is ignored on load — so a room
  cannot accumulate results whose players have all gone.
- **The host role moves.** Whoever is left runs the board: when the host leaves a game or their seat
  expires while away, `rehostGame()` hands the host role to the remaining player and tells them so
  (`game-host`), so a finished game can still be rematched, approved and cleared. A seated player can
  also run a board whose host is not in the room at all, which rescues state stored before that rule.
- **A seat is not a spectator seat.** Taking a seat removes that account from the watchers (the dock used
  to show a player as both), and a player cannot be added to the spectator count by `game-watch`.
- **Legal moves come from the object.** Every `game-view` carries `moves` for the side to move (playable
  columns for Connect Four, empty squares for tic-tac-toe, flipping squares for Reversi). The dock marks
  and enables only those, so a phone — which has no hover state — is not guessing, and an impossible
  move is not something the UI offers only for the server to refuse.
- **Budgets:** game events use `gameLimited()` (60 per 10 s per connection), never the chat window. A
  suite check sends 25 game events and then a message to prove the message still lands.
- **HTTP:** `GET /api/games` lists every game *still running* in a room the caller may enter — a finished
  board is a result inside its room, not something to discover and watch from outside.
- **UI:** the room's **🎲 Games** button carries a count of the games running in that room. Opening it
  shows that room's games (tap one for its board and actions) or the create form when it has none. The
  list is the games being played and nothing else — a finished board is never a row, and a row's chip is
  an invitation ("your move", "open"). The result of a finished board lives on its own screen, under the
  board, with the rematch; leave that screen and the room has no trace of it. The **room list begins with
  a Games card** — same shape as a room card, a badge with the total — which opens the all-games view with
  Watch / Join / Request. Games stay invisible until one of those is opened, as specified.
- **Defaults taken** from the open questions: host, moderators and the admin may approve/end; the card
  shows the count, game name, room and seats, no board preview.

## As built (`v=94`, split panel + solo arcade)

- **The game sits beside the conversation.** Opening the room's Games button no longer covers the chat:
  `#chatSplit` holds `#messageList` (60%) and `#gamePane` (40%), as two columns from 860px and stacked
  at the same ratio below it. `tests/games-ui.js` measures the ratio in a real browser instead of
  trusting the CSS, and it also proves the messages are still on screen with the panel open.
- **The composer never moves.** It stays outside the split, so a message can be typed and sent while the
  board is open, and a game move never hides the input.
- **Boards follow the panel's height**, not its width: `.game-pane-body` is a size container and the
  boards cap themselves at `100cqh`, so Connect Four, the grids and (next) chess fit the 40% panel on a
  phone instead of hanging off the bottom of it. A ⤢ toggle swaps the split for a full-room board and
  back; closing the panel resets it.
- **Two surfaces, on purpose.** A game in the room you are in opens the panel; the all-games card in the
  room list still opens a modal, because it lists games in *other* rooms and is a directory rather than
  something you play from here.
- **Solo arcade is static.** `public/arcade-2048.html` and `public/arcade-sudoku.html` are standalone
  pages (no socket, no Worker, no rate limit) linked from the Games panel and the all-games list. A
  puzzle has no opponent, so there is no seat to take and nothing for the object to validate, and
  nothing for anyone to cheat at. Their boards use `minmax(0,1fr)` with `min-width:0`, because a plain
  `1fr` floors a column at the min-content width an `aspect-ratio` cell reports, which made the grid
  overflow its panel.
- **The sudoku proves itself.** A puzzle is only shown after its own solver confirms exactly one
  solution; a puzzle with two makes "Check" lie to whoever found the other one. Generation is MRV-first
  and lands in single-digit milliseconds.
- **2048 keeps the merge rule honest:** a 2-2-2-2 line becomes 4-4, not 8, with one level of undo.

## As built (`v=95`, chess)

- **The position is FEN and the rules are the library's.** `game.fen` is the state; `Chess` from
  `chess.js` (BSD-2-Clause, a dependency rather than a vendored file because it ships as ESM and wrangler
  bundles it) generates the moves and judges mate, stalemate, insufficient material, threefold repetition and
  the 50-move rule. Hand-written chess rules are exactly where castling and en passant go quietly wrong.
- **Standard clock:** five minutes each, no increment (`CHESS_CLOCK_MS`, env-overridable so the suite can use
  four seconds). A move first subtracts the time it took; a flag that already fell means the move never lands
  and the game is lost on time. `settleChessClock()` runs on the sweep, and the sweep's next-wake calculation
  schedules the alarm for the moment a flag falls, so a timeout ends the game with nobody touching it.
- **Draw offers and resignation are their own events** (`game-offer-draw`, `game-accept-draw`,
  `game-resign`), not overloaded onto "leave": leaving already forfeits, but it also gives up the seat and
  the wrong word is the wrong shape for "I resign". An offer only stands until the offerer moves.
- **Colours swap on a rematch.** White always moves first, so instead of alternating the opening seat the
  restart reverses the players; the clock, the last-move marker and any open offer are reset with the board.
- **The client knows no rules at all.** The view carries a 64-square board of `wK`/`bP` codes, the legal
  moves for the side to move, the last move, a `check` flag and both clocks; the panel decides only which way
  up the board is (your colour at the bottom, spectators watch white's way) and what a tap means. Promotion
  shows four pieces because the server lists one move per piece; a move without a promotion piece is refused.
- **Chess shows its board while it waits.** The starting position and the clocks are drawn in the lobby
  (the other kinds stay empty until they start), because "what am I about to play, and how long do I have"
  is exactly what somebody waiting wants to see.

## As built (`v=96`, Draw & Guess)

- **The word is the drawer's secret, and the state packet never carries it.** `game.round` holds the word in
  the object; `gameView` sends the mask and, once the turn is over, the word. The drawer is told their word
  privately (`game-word`), on picking and again on `game-sync`, so a reconnect restores it without a spectator
  ever being able to read it out of a broadcast.
- **Guesses are the room's own chat.** The "message" path checks text for the word before the message can be
  stored: a sentence containing it becomes a `system` message ("xyz guessed the word") and the sentence itself
  is never written to the transcript. Matching is by whole words, so "concatenate" is not "cat" and a two-word
  answer has to appear together. The drawing player typing the answer is refused rather than posted, because a
  drawer could otherwise spoil their own round. Clients cannot post `system` messages: it is not in
  `MESSAGE_KINDS`, only the object writes them.
- **Standard settings:** `DRAW_ROUNDS` 3 (everybody draws once per round), `DRAW_SECONDS` 80,
  `DRAW_CHOOSE_MS` 15 s to choose from three words (the first is taken if the drawer says nothing),
  `DRAW_REVEAL_MS` 5 s to read the answer before the next drawer. All four are env-overridable, which is how the
  suites play a whole game in seconds.
- **Scoring:** a guesser earns up to 200 scaled by the time left on the turn clock (never less than 50), and the
  drawer earns 50 per correct guesser — drawing well has to pay. Guests keep a separate score list, per the
  owner's rule, and both lists are shown.
- **Strokes are batched and bounded.** One event per stroke with its points, at most 200 points per stroke and
  a fixed palette, coordinates clamped to the 1024×768 canvas. A long drag is sent as consecutive strokes rather
  than truncated. Strokes are broadcast every time but written to storage only every twentieth, because the
  free tier meters rows written and a drawing would otherwise cost a row per finger movement.
- **Timers are the object's, not the client's.** The sweep settles a drawer who never chose, a turn whose clock
  ran out and a reveal that has had its time, and its next-wake calculation brings the alarm forward to whichever
  of those is due, so a turn ends with nobody touching the page.
- **A rejoining player redraws from state**, not from a stroke stream: the canvas is repainted from the strokes
  the object holds, so a reload shows the picture as it stands.
- **Covered by** `tests/draw.js` (37 checks: secrecy, masking, refusals, stroke limits, guess matching, scoring,
  rotation, the auto-pick, and a whole three-round game to a result) and `tests/draw-ui.js` (16 checks in two
  browsers: the picker, the mask, the tools being the drawer's alone, a pointer stroke reaching the other
  canvas, and a chat sentence turning into the highlighted line).

## As built (`v=97`, Draw & Guess played for real)

Everything below is a defect that only showed up once the game was played as a game rather than through a suite.

- **A game with a range of seats waits for its host.** Draw & Guess seats two to eight, but it used to start the
  moment a second player arrived, so a third was always told "that game already started" and every game was a
  two-player game wearing an eight-seat label. A two-seat board (Connect Four, tic-tac-toe, Reversi, chess) still
  starts when its last seat fills; Draw & Guess stays in its lobby with a **Start now (N playing)** button for the
  host (`game-start`, host or moderator, refuses below `minSeats`).
- **The auto-picked word reaches the drawer.** `DRAW_CHOOSE_MS` gives the drawer 15 s to choose and then takes the
  first word for them - and the drawer was never told which one. Their client opens the canvas only when it knows
  the word, so the turn was 80 blank seconds nobody could draw in. `pickDrawWord` now tells the drawer privately,
  which covers both the choice and the auto-pick, and `game-pick-word` no longer repeats it.
- **A stroke is broadcast as a stroke.** The whole drawing used to ride in a `game-state` on every line: quadratic
  in the number of strokes, measured at 135 KB for the first twenty strokes and 892 KB for the next eighty to one
  watcher, and every packet rebuilt the panel and repainted the canvas under the drawer's finger. `game-draw` now
  broadcasts `game-stroke` (`seq` + one stroke) and `game-clear` broadcasts `game-cleared`; a client that sees a
  gap in `seq` asks for `game-sync` instead of drawing a picture with a line missing. Measured after the change:
  661 bytes per stroke, flat (13 KB for twenty strokes, 26 KB for the next forty). Strokes also have their own
  rate window (`DRAW_EVENT_LIMIT`, 120 per 10 s per connection) so a scribble cannot be dropped silently by the
  seat-change budget, and the stored drawing is capped at `DRAW_POINTS_TOTAL_MAX` (12 000 points) because the full
  state travels in one WebSocket message and Cloudflare closes a socket past 1 MiB.
- **One player leaving a bigger game does not end it.** `game-leave` and the away sweep ended any running game and
  handed the win to `players[0]`; with more than two seats the seat is now dropped and the game carries on, and
  only a fall below `minSeats` is a forfeit. A drawer who leaves has their turn revealed early and the rotation
  carries on from the seat they held (`advanceDrawTurn` is anchored to the previous drawer's id, never to a stored
  index, so removing a seat cannot skip a player).
- **The turn says who has guessed.** `gameView` carries `guessed`, the seat cards mark a player who has already
  guessed (✔) next to the drawer's ✏️, and the board prints "N of M guessed" over the players *and* the guests,
  because the turn waits for both.
- **Points, not wins.** `endGame` adds a win to the winner, which printed 601 for a 600-point game; Draw & Guess is
  excluded, and the seat cards print "pts" for it and "wins" for chess instead of "1 pts".
- **A phone can actually see the drawing.** At 390 px the canvas sat below the fold in the 40% pane: the seats, the
  word and the guessed line used every pixel, so a guesser saw the mask and no picture at all. A game that is being
  played now takes 55% of a phone split (the chat keeps 45%), and `fitDrawCanvas` gives back exactly the pixels the
  rows around the board need, measured after the DOM is complete. Measured at 390×844: pane 356 px, content 317 px,
  zero scroll, canvas 301×226 for a guesser and 278×209 for the drawer, with the conversation on screen beside it.
- **The drawer is told when it is their turn** even with the panel shut (`game-word` toast), and a phone layout
  choice survives until the panel is closed.
- **Covered by** `tests/draw.js` (50 checks, including the lobby and the start, a third seat, the stroke delta, the
  auto-pick reaching the drawer, a player leaving a three-player game, and the whole game to a result) and
  `tests/draw-ui.js` (24 checks in two browsers, adding the start button, the people page and the guessed line).

## As built (`v=98`, a game panel that is a game and not a control panel)

The v=97 pane still stacked seats, a scoreboard, a status line, the board and up to five full-width buttons in one
scroll container. At 40% of a phone that is a scrollbar over a game, and the buttons were the biggest rows in it.

- **Three pages behind one header.** The panel is the **board** (what a player is watching), the **people** (seats,
  points, guest scores, join requests, seat count and watchers) and the **options** (leave, end game, clear,
  resign, offer/accept a draw, watch, new game). `👥` and `⋯` in the panel header swap the body, a second tap returns
  to the board, and `‹` goes back (board → room's games on the board page, sub-page → board). The title becomes the
  page's name, so nothing needs a header row of its own.
- **The board keeps only the action it is waiting for**: Join/Request in a lobby, Start now for a Draw & Guess
  host, and Rematch as a `↻` glyph beside the result. Everything else is a page away, which is why a board fits a
  40% pane again.
- **Glyphs where a word was wasted**: `⌫` clears the canvas (in the state line, not at the end of the tool row),
  `↻` rematches, `‹ 👥 ⋯ ⤢ ✕` are 26 px squares. The options page is one-word buttons (`Leave`, `End game`,
  `Clear`, `New game`, `Resign`, `Watch`) two to a row instead of five full-width rows: the page's `.primary` and
  `.secondary` are `width:100%`, which in a 40% pane made every action a row of its own.
- **The drawing board is one line plus the picture**: `R1/3 · 2 of 3 guessed · 1:58 · ⌫`, then the word or mask,
  then the canvas, then one row of eight colours and three widths. The seats, the scoreboard and the actions are
  gone from it, so a guesser's canvas is 301×226 on a 390 px phone with the chat above it - the bug this pass
  exists for. The chat echo strip (`draw-recent`) stays for the maximised panel, where the chat itself is hidden.
- **Every board gets 55% of a phone split**, not just a canvas: a chess board in 40% of a 390 px screen was 139 px
  wide (17 px a square) and taller than it was broad, because the piece glyph was sized in `vw` and overflowed each
  square. Pieces are now sized in `cqw` of the board (9cqw), the board is 225×225 and square, and `fitDrawCanvas`
  (now the fit for any board: canvas 4:3, Connect Four 7:6, grids square) trims the last few pixels so no board
  scrolls. Measured at 390×844: chess 225×225 with both clocks and the state line visible, zero scroll.
- **Covered by** `tests/draw-ui.js` (24 checks: the board page carries no seats, `👥` opens and closes the people
  page, the start button, the picker, the mask, the ink, the guess line, the reveal, the seat cards with points) and
  `tests/games-ui.js` (25 checks in two browsers: the three pages, the same stranded-player paths as before through
  the new navigation, the `↻` rematch, the options page's Leave).

## As built (`v=99`, the board bigger, the door in the header, chess on a real clock)

- **Bigger boards on a phone.** A game being played takes **60%** of the split (the chat keeps 40%) and the header
  is 24 px glyphs below 480 px. Measured at 390×844: a drawing is 349×262 for a guesser and 327×245 for the drawer
  (was 301×226 / 278×209), a chess board is 261×261 (was 225), and none of them scrolls.
- **Chess pieces are two opposite tones**, not two greys: a warm ivory side (`#fff6e4`) and a cold near-black side
  (`#0e1220`), each with a hard one-pixel rim and sized `10cqw` of the board. Black-on-slate and white-on-pale were
  the two pairs that disappeared; the dark-theme squares moved to `#64718f` / `#333f59` for the separation.
- **Leaving moved into the header.** `🚪` sits with the navigation and shows only while a seat is held (not for a
  spectator, not on an ended board). A running two-seat game asks first, because there the seat is the whole game;
  in a bigger game the seat just goes and the game carries on. The options page keeps only the deliberate actions
  (`End game` for a host, `Clear`, `New game`, `Resign`, draw offer, `Watch`).
- **Chess has a clock to choose.** The create form shows a `Clock` row for chess only: **10 min / 20 min / 40 min /
  No clock** (default 20). The game carries its own `clockMs`; `startGame` builds the clock from it, `0` means no
  clock at all (no ticking, no flag, no alarm to wake for, no clock row in the panel), and an allowance that is not
  one of the four falls back to the room default `CHESS_CLOCK_MS` (which is how the suites run a 4 s clock). A
  rematch keeps the same allowance.
- **Join requests are answered above the board.** A host (or an admin) sees one request at a time in a strip above
  the board - "name wants to join · Let in · No · 1 of 3" - so a queue is worked through without leaving the game.
  The people page still lists them all.
- **Covered by** `tests/chess.js` (29 checks, adding a 20-minute game, a game with no clock that still plays, and an
  allowance outside the four falling back to the default), `tests/games-ui.js` (26 checks, leaving through the header
  door and its confirm) and the 390×844 phone check (14) plus `.forge/tmp/shot-new.js` (10: the clock row appearing
  only for chess, its four choices, the 20-minute clocks, the request bar and the header door).

## As built (`v=100`, starting a game is a wizard, and the maximise glyph is drawn)

- **The ⋯ page is where a game starts.** All five kinds are one tap each in a fixed two-column grid that never
  scrolls; picking one asks **Who can join?** (Anyone can join / Only by request); answering it reveals the game's
  own options where it has any (a chess clock) and a **Start game** button that creates it. The same wizard is the
  room's empty-dock view, so there is one create surface rather than a form and a wizard. It fits a 390×844 phone
  with no scrollbar at every step (measured in `.forge/tmp/shot-wizard.js`).
- **It is offered where it can work.** The wizard appears on the ⋯ page when the room can take another game and the
  player holds no seat elsewhere (one seat per person per room is a server rule, so offering it mid-game would be a
  dead end); ending or leaving a game turns the same page into the way to start the next one. Under it, that game's
  own deliberate actions (`End game` for a host, `Clear`, `Resign`, the draw offer, `Watch`).
- **The create view gets the pane.** The wizard needs the same height as a board, so the dock's create view takes
  60% on a phone instead of the 40% a list gets; the list of running games still keeps the chat's 60%. The solo
  arcade was dropped from the create view (two rows) and stays in the all-games list.
- **The maximise arrows are drawn, not typed.** `⤢`/`⤡` sat a pixel or two off centre because they are text on a
  button's baseline; the toggle now carries a 14 px SVG on a grid-centred button and measures exactly centred
  (dx 0, dy 0 in the check). Every header button is grid-centred for the same reason.
- **Covered by** `.forge/tmp/shot-wizard.js` (17 checks: five kinds, no scrollbar at any step, the policy question
  appearing only after a kind, Start only after the policy, the clock only for chess, the options page offering the
  wizard only when it can work, and the maximise icon's geometry), plus `tests/draw-ui.js` (24) and
  `tests/games-ui.js` (27, now measuring the create view's 60% and the list's 40%).

## As built (`v=101`, boards take most of a phone)

- **A board takes 68% of a phone split** (the chat keeps 32%) instead of 60, the pane header is 4 px padding with
  24 px glyphs and the body padding is 8 px: measured at 390×844, a drawing is **374×281** for both roles (was
  349×262 / 327×245), chess is **319×319** (was 261), Connect Four **374×322**, tic-tac-toe **358×358** - and none
  of them scrolls. The drawing is now the pane's full width, so only a wider pane could make it bigger.
- The list of running games and the wizard keep the 60/40 default and 60% respectively; the chat at 32% still shows
  the last two or three messages above the composer.
- The quick chess clock offered is now **10 min** (`CHESS_TIME_OPTIONS = [10, 20, 40, 0]`), and 5 is no longer
  accepted - a create that names it falls back to `CHESS_CLOCK_MS` like any other un-offered allowance, which
  `tests/chess.js` now proves by asking for 5.

## As built (`v=102`, boards bigger again, and the drawing board's own bugs)

- **A board takes 70% of a phone split** (the chat keeps 30%) and its rows go edge to edge: only the text keeps an
  8 px margin, so a canvas gains the last 16 px of width. The chess clocks also absorbed the "Your turn" line into
  their own row, and every board's height cap was corrected to what the rows actually cost (`fitDrawCanvas` still
  trims the remainder). Measured at 390×844, all with zero scroll: a drawing **390×293** (the full width of the
  phone - only a bigger screen can grow it), chess **361×361** (was 261 at the start of this pass), tic-tac-toe
  **371×371**, Connect Four **390×335**.
- **The colour and brush no longer reset.** Every game-state packet rebuilt the board and with it the tools, so a
  correct guess put the drawer back on the default navy at the default width. The choice is module state
  (`drawChoice`) now, and the tool buttons render their active state from it.
- **A stroke in progress keeps its canvas.** A state packet that lands mid-drag used to tear the canvas out from
  under the finger (the pointer capture died with the element). `renderGames` now defers while `drawStrokeActive`,
  and the deferred render runs the moment the line is sent.
- **Undo (↶) exists**, and **Clear (⌫) asks first.** A stroke was the unit of everything and one bad line cost the
  whole picture. The object takes back the drawer's last line (`game-undo`, drawer only, sequence bumped like a
  stroke) and every canvas repaints from the shortened list; Clear goes through the confirm dialog because it is the
  one destructive control in the state line.
- **The tools are thumb-sized**: 24 px colour swatches (was 18) and 30 px brush buttons (was 22), in one row of eight
  colours and three widths that still fits 390 px without scrolling.
- **Covered by** `tests/draw.js` (54 checks: undo reaching the room, a guesser being refused it, the sequence moving
  on, and the drawing one line shorter) and `.forge/tmp/draw-issues.js` (10 checks at 390×844: full-width canvas,
  thumb-sized tools, colour and brush surviving a guess, a mid-stroke packet not replacing the canvas, undo taking a
  line back, Clear asking first and a cancel leaving the drawing alone).

## As built (`v=104`, five brushes and a bucket of paint)

- **Five brushes, not three** (`DRAW_SIZES = [1..5]`, width `size * 6` on the 1024×768 canvas, so 6 to 30 px): a thin
  pen for eyes and whiskers, a fat marker for blocking in a large area. The object clamps to the same five values it
  did to three, so a client cannot smuggle in a width the palette does not offer.
- **A bucket that floods a region.** Tap the bucket, then tap the canvas: the region under the finger - everything
  sharing that pixel's colour out to the nearest stroke - is filled with the chosen colour. It is a **mode** that
  stays lit until tapped again, because a picture is filled a region at a time and re-arming it per region would be a
  tap each. White is on the palette, so a fill is also the eraser.
- **A fill travels as its seed, not as a raster.** `game-draw` carries `{ color, fill: true, points: [seed] }`; the
  region is computed on each client by replaying the same strokes in the same order onto the same 1024×768 bitmap, so
  every screen covers the same pixels and the object stores one point instead of a mask it could never afford. The
  match is a **tolerance** (`FILL_TOLERANCE = 64`) rather than equality, or a hard test would leave a rim of
  antialiased pixels inside every shape; the result goes back through `putImageData`, so the fill's own edge is hard
  on every browser. A 1024×768 flood - 786 432 pixels, the whole empty canvas - measured **20 ms**.
  `cleanStroke` truncates a fill to its one seed point and gives it no brush width, and `gameView` had to learn the
  flag too: it copies strokes field by field, and a rejoining client that got a seed without it painted a fill as a
  zero-length line, one dot. That is what `tests/draw.js` caught.
- **The tools are two rows under the canvas**: eight colours, then five brushes and the bucket. `.draw-tools` wraps
  instead of scrolling - one line when the pane is wide (desktop), two on a phone - so nothing is ever hidden
  sideways at 390 px. The bucket is drawn as an SVG (bucket plus falling drip) rather than typed: 🪣 does not exist on
  every phone and desktop this runs on, and a bin reads as "delete the drawing". Measured at 390×844: 379 px of
  canvas width (the second row costs `fitDrawCanvas` a sliver, 7 px of the 386 the row used to take), 30 px on every
  tool, and 20 ms for the largest fill.
- **Covered by** `tests/draw.js` (58 checks, adding: the widest brush surviving the cap, a fill travelling as one
  seed with no width, and a sync replaying the fill with the drawing) and `tests/draw-ui.js` (31 checks, adding:
  five brushes and one bucket for the drawer alone, the widest brush lighting up, the bucket arming itself and
  turning the cursor, a tap flooding the guesser's canvas, both screens flooding the same pixels, the fill stopping
  at the line instead of painting over it, and a second tap going back to the pen). `.forge/tmp/draw-issues.js`
  (17 checks at 390×844) adds the tool rows never scrolling sideways, every tool staying inside the phone, the
  bucket being thumb-sized, a flood landing in the chosen colour, and the whole-canvas fill timing.

## As built (`v=105`, a board takes three quarters of a phone and half of a desktop)

- **A board takes 75% of a phone split** (the chat keeps 25%) instead of 70, which is the point where a chess board
  reaches the phone's *full* width: at 390×844 it measured 361×361 and now measures **390×390** - the 29 px it was
  short was the whole of what it was missing. A drawing goes **379×284 → 390×293** for the drawer (those 11 px of
  width came back because with the taller pane `fitDrawCanvas` no longer has to trim for the two tool rows) and stays
  390×293 for the guesser, which was already at full width. Neither scrolls, and the chat keeps 162 px - the last
  message or two above the composer.
- **A board now takes half of a desktop room** (the chat keeps the other half), where every view used to keep the
  40%. On a desktop the pane's *width* is what capped a board, not its height: at 1440×900 the pane was 576 px wide
  and 691 tall, so chess measured **555** where the pane's height allowed 583, and a drawing **555×416** where its
  4:3 shape and that height allowed 699×524. With the pane at 720 px: chess **583×583**, now capped by the window's
  height rather than by the pane (no wider a pane can beat it), and the drawing **699×524** - 58% more drawing
  area. The list of running games keeps the 60/40 default; the create wizard gets the same half as a board.
- **Measured before → after at nine screen shapes** (chess, then a drawing drawn and guessed, with the pane's
  overflow checked at each and 0 everywhere except where noted): chess 320×568 **167 → 186**, 360×640 **218 → 240**,
  390×844 **361 → 390**, 430×932 **422 → 430**, 1024×768 **389 → 451**, 1280×800 **483 → 483** (already capped by the
  height there), 1440×900 **555 → 583**, 1920×1080 **747 → 763**; the drawing 360×640 **189×142 → 219×164**,
  1024×768 **389×291 → 491×368**, 1280×800 **491×368 → 590×443**, 1440×900 **555×416 → 699×524**, 1920×1080
  **747×560 → 939×704**.
- **Two limits worth knowing, both older than this pass.** The tightest phone (320×568) gives the pane 280 px, so
  the drawer's rows (24 + 21 + 120 + 59) still overrun the 160 px floor `fitDrawCanvas` clamps at - **10 px** of
  scroll left, down from 29. And a phone held **landscape** (844×390) gets the stacked layout because the breakpoint
  is a width: the room is 180 px tall there, so chess is **46 px** (was 36) and a drawing 160×120 with 84 px of
  scroll, whatever the split says. Fixing that means a height-aware breakpoint, which is its own change.
- **Covered by** `tests/games-ui.js` (26 checks, including the games list still keeping 60% for the chat) and
  `tests/draw-ui.js` (31), both green on this change, plus two harnesses in `.forge/tmp/` that produced every number
  above: `board-size.js` (before/after at a phone and a desktop, printing the pane's rows and the board's cap) and
  `board-shapes.js` (nine shapes, a run per split, resizing one live game and re-rendering it the way a state packet
  does). The chess board had no UI suite of its own beyond these measurements - `.forge/chess-ui.js` still looks for
  the pre-wizard `.game-kind` buttons and fails on the current markup.
