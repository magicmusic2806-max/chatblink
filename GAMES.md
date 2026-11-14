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

## Shared plumbing to build once

A "game dock" in a room: game state per room in the DO, `game-start` / `game-move` / `game-state` /
`game-end` events, server-side validation, turn timeouts, spectator list, and a resync on reconnect.
Front end: one dock component in `public/multi-room.js` and one CSS block, reused by every game.
Game events get their own rate limit in `rateLimited()` so they never touch the chat budgets.

## Decisions needed before building

1. **Where games can run:** every room, private rooms only, or a dedicated "games" built-in room?
2. **Who can start one:** anyone in the room, the room creator, or a vote?
3. **Draw & Guess details:** words safe for an 18+ chat or a deliberately clean list? Rounds per
   game and seconds per round? Drawer chosen round-robin or at random?
4. **Spectators:** can people watch without playing (recommended), and do their messages count as
   guesses (yes in the room chat)?
5. **Chess:** human-vs-human only, or is a bot (`stockfish.js`, GPL-3.0) acceptable later?
