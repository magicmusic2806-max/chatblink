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

Room game state lives in the DO's memory next to `this.roomCalls`, keyed by room id, and is rebuilt
on restart the same way (a game in progress ends when the object restarts; that is acceptable and
simpler than persisting mid-game state):

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

1. **Dock + Connect Four.** ✅ Shipped in `v=78`. The dock, the event set, open/request/spectate, host
   approve/deny, reconnect resync, the games card, and the game-list aggregation all exist now.
2. **Draw & Guess** on the same dock: word list (curated, safe, from the Unlicense list), round clock,
   masked word, guessing in the room chat, separate guest scoring and the end scoreboard.
3. **Chess** (`chess.js` BSD-2 + `cm-chessboard` MIT), human only, with clocks and draw offers.
4. **Solo arcade** (2048 MIT, sudoku MIT) served as static pages and listed in the same Games card,
   watchable but not joinable.
5. **Poker / trivia** only if demand appears.

## As built (v=78, Connect Four)

Everything below is what the code actually does, not the plan it came from:

- **State** lives in the DO's memory as `this.roomGames` (room id → game), next to `this.roomCalls`.
  One game per room at a time; a finished game stays on the board until the host starts another or
  closes it.
- **Seats** come from `GAME_KINDS` (`connect-four: 2`). The host takes the first seat when creating.
  `policy: "open"` fills the seat on `game-join`; `policy: "request"` puts the person in `pending` and
  notifies the host, who approves or denies from the dock.
- **Refusals carry a sentence** in a `game-error` event: not your turn, only players may move, that
  column is not on the board / is full, the game already started, only the host can do that.
- **The board is one flat array** of 42 cells (`index = column * 6 + row`, row 0 at the bottom; 0 empty,
  1 and 2 the seats). Win detection is a four-direction run check on the disc just placed.
- **Leaving** a running game forfeits it (the other player wins, `reason: "left"`); leaving a lobby game
  the host created closes it. A closing socket removes a spectator but keeps a player seated so a
  reload can carry on.
- **Budgets:** game events use `gameLimited()` (60 per 10 s per connection), never the chat window. A
  suite check sends 25 game events and then a message to prove the message still lands.
- **HTTP:** `GET /api/games` lists every game in a room the caller may enter, for the room list's card.
- **UI:** a **🎲 Games** button in the room's tool row opens the dock; the room list gets a **Games in
  rooms** card with the first three live games and a "See all" list; both modes are one modal
  (`#gamesModal`). Games are invisible until one of those is opened, as specified.
- **Defaults taken** from the open questions: one game per room; host, moderators and the admin may
  approve/end (a silent host must not strand a room); the card shows room, game and seats, no board
  preview.

## Remaining for Draw & Guess

- Word list: curated and safe, from `dwyl/english-words` (Unlicense). Never fetched at runtime.
- Rounds, seconds per round, drawer rotation, masked word in the transcript, guesses in the room chat.
- Guests: separate score list, "xyz guest guessed the word" system line, end-of-game scoreboard showing
  players and guests independently.
- Strokes: batched (~50 ms per stroke, capped), redrawn from state on rejoin, never stored per point.
