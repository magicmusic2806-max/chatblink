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

- **In a room:** a **Games** button beside the existing actions opens a small dock listing that room's
  game (or the create list when there is none). The dock carries the player list, seats, host approve
  / deny controls, the scoreboard and the spectator count. Collapsed by default.
- **Room list:** a **Games** card above the room grid showing every live game across rooms with its
  room, game, seats taken and the three actions. It is the only place games are discoverable without
  opening a room, which is what "hidden by default" means.
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
6. **Draw & Guess.** Next, and the one users asked for by name. Design below.
7. **Chess** (`chess.js` BSD-2 + `cm-chessboard` MIT), human only, with clocks and draw offers.
8. **Solo arcade** (2048 MIT, sudoku MIT) served as static pages and listed in the same Games entry,
   watchable but not joinable.
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

## Remaining for Draw & Guess

- Word list: curated and safe, from `dwyl/english-words` (Unlicense). Never fetched at runtime.
- Rounds, seconds per round, drawer rotation, masked word in the transcript, guesses in the room chat.
- Guests: separate score list, "xyz guest guessed the word" system line, end-of-game scoreboard showing
  players and guests independently.
- Strokes: batched (~50 ms per stroke, capped), redrawn from state on rejoin, never stored per point.
