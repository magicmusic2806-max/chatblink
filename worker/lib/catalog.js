export const GIF_PACKS = {
  casual: ["/gifs/hello.gif", "/gifs/coffee.gif", "/gifs/party.gif", "/gifs/fistbump.gif"],
  fun: ["/gifs/party.gif", "/gifs/laugh.gif", "/gifs/hello.gif", "/gifs/fistbump.gif"],
  comedy: ["/gifs/laugh.gif", "/gifs/party.gif", "/gifs/hello.gif", "/gifs/heart.gif"],
  dating: ["/gifs/heart.gif", "/gifs/sunset.gif", "/gifs/hello.gif", "/gifs/party.gif"],
  adult: ["/gifs/moon.gif", "/gifs/heart.gif", "/gifs/sunset.gif", "/gifs/berry.gif"],
  friends: ["/gifs/fistbump.gif", "/gifs/hello.gif", "/gifs/party.gif", "/gifs/hug.gif"],
  "best-friends": ["/gifs/hug.gif", "/gifs/heart.gif", "/gifs/fistbump.gif", "/gifs/berry.gif"],
  ocean: ["/gifs/ocean.gif", "/gifs/party.gif", "/gifs/hello.gif", "/gifs/fistbump.gif"],
  sunset: ["/gifs/sunset.gif", "/gifs/heart.gif", "/gifs/party.gif", "/gifs/hello.gif"],
  berry: ["/gifs/berry.gif", "/gifs/party.gif", "/gifs/heart.gif", "/gifs/hug.gif"],
  forest: ["/gifs/forest.gif", "/gifs/hug.gif", "/gifs/hello.gif", "/gifs/party.gif"]
};
export const DEFAULT_GIFS = GIF_PACKS.casual;

export const BUILT_INS = [
  { id: "casual", name: "Casual", icon: "☕", vibe: "Easy conversation, everyday thoughts, no pressure.", accent: "#4f8cff", soft: "#eaf2ff", gifs: GIF_PACKS.casual, emojis: ["👋","😊","☕","🌤️","💬","✨","🙌","😌","🍃","📚","🎧","🌻","🛋️","🧸","🍵","🎵","🌙","💤","👀","🙂","🌼","🪴","😄","🕊️"], stickers: ["HELLO! 👋","GOOD VIBES ✨","SAME 😌","TELL ME MORE 💬","COFFEE? ☕","TAKE IT EASY 🍃","NICE ONE 🙌","HERE FOR YOU 💛","DAYDREAMING 🌤️","CHAT SOON 💭"] },
  { id: "fun", name: "Fun", icon: "🎉", vibe: "Games, playful questions and spontaneous chaos.", accent: "#8b5cf6", soft: "#f2edff", gifs: GIF_PACKS.fun, emojis: ["🎉","🤩","🥳","🎲","🚀","🔥","⚡","🪩","🎮","🎯","🏆","🍿","🎈","🕺","💃","🥁","🎪","🤹","🎨","🛹","🎳","🧩","🔮","😎"], stickers: ["LET'S GO! 🚀","PLOT TWIST ⚡","PARTY TIME 🥳","I'M IN 🎲","GAME ON 🎮","HIGH SCORE 🏆","ONE MORE 🎯","WILD CARD 🃏","DANCE BREAK 🕺","CHAOS MODE 🌪️"] },
  { id: "comedy", name: "Comedy", icon: "😂", vibe: "Jokes, memes and the lighter side of everything.", accent: "#f59e0b", soft: "#fff5da", gifs: GIF_PACKS.comedy, emojis: ["😂","🤣","😭","💀","🤡","😹","🙃","🎭","🤪","😆","🍌","🐸","👻","📢","🎤","🥸","😜","🤭","🫠","🙈","🤦","💩","🙉","🎬"], stickers: ["I CAN'T 😂","COMEDY GOLD 🏆","TOO REAL 💀","BA-DUM-TSS 🥁","LOL 🤣","I'M CRYING 😭","CLASSIC 🤡","BIG MOOD 🎭","SEND HELP 🆘","NICE TRY 😜"] },
  { id: "dating", name: "Dating", icon: "💘", vibe: "Respectful conversation for singles open to a spark.", accent: "#ec4899", soft: "#fff0f7", gifs: GIF_PACKS.dating, emojis: ["💘","🌹","😉","🥰","❤️","🫶","✨","🍷","💌","🌙","🎶","🥂","💐","😍","💞","🕯️","🍫","💃","🕺","💍","🧡","💋","🌸","😊"], stickers: ["HEY YOU 💘","CUTE! 🥰","COFFEE? ☕","GOOD ENERGY ✨","YOU'RE SWEET 🌹","DINNER? 🍷","TELL ME MORE 💌","HEART EYES 😍","CHEERS 🥂","DATE NIGHT 🌙"] },
  { id: "adult", name: "Adult", icon: "🌙", vibe: "Mature 18+ conversation with boundaries and respect.", accent: "#7c3aed", soft: "#f1ebff", gifs: GIF_PACKS.adult, emojis: ["🌙","🖤","🍷","😏","🔥","🫦","💜","✨","🕯️","🎶","🥂","🌌","🃏","♠️","💋","🧊","🌃","🍸","🎷","🛋️","💤","😈","🪩","🍒"], stickers: ["AFTER DARK 🌙","BE RESPECTFUL 🖤","CHEERS 🍷","VIBE CHECK ✨","NIGHT OWL 🦉","SLOW BURN 🔥","MYSTERY 🃏","MIDNIGHT TALK 🌌","CLASSY 💜","KEEP IT SECRET 🤫"] },
  { id: "friends", name: "Friends", icon: "🤝", vibe: "Meet people, find common ground and stay awhile.", accent: "#10b981", soft: "#e7faf3", gifs: GIF_PACKS.friends, emojis: ["🤝","🫶","😄","🎧","🎮","🍕","🌈","💚","👋","🙌","🏀","🎬","🧋","🍔","🎳","🎤","🚴","🏕️","🎨","🐶","🌞","🍀","💬","🎊"], stickers: ["NEW FRIEND? 🤝","YOU GOT THIS 💚","HANG OUT? 🎮","PIZZA TIME 🍕","SQUAD UP 🙌","ROAD TRIP 🚐","GAME NIGHT 🎲","GOOD TIMES 🌈","COUNT ME IN ✋","SEE YOU SOON 👋"] },
  { id: "best-friends", name: "Best Friends", icon: "🫂", vibe: "Deeper chats, trusted circles and familiar faces.", accent: "#0ea5a4", soft: "#e5fbfa", gifs: GIF_PACKS["best-friends"], emojis: ["🫂","💙","🥹","🫶","🧸","🌻","🤞","💫","💌","🕊️","🎀","🍰","🌙","📸","🫧","🎵","🌸","🤗","💎","🏡","🥰","✨","☕","🔒"], stickers: ["I GOT YOU 🫂","FOREVER TEAM 💙","PROUD OF YOU 🌻","CORE MEMORY 💫","ALWAYS HERE 🧸","MISS YOU 🥹","BEST DAY 🎀","HOME 🏡","TIGHT HUG 🫂","LOVE YOU 💙"] }
].map(room => ({ ...room, access: "open", builtIn: true, ownerId: null, members: [], requests: [], createdAt: null }));

export const ALL_EMOJIS = [...new Set(BUILT_INS.flatMap(room => room.emojis))];
export const ALL_STICKERS = [...new Set(BUILT_INS.flatMap(room => room.stickers))];
export const ALL_GIFS = [...new Set(Object.values(GIF_PACKS).flat())];
export const roomMedia = room => room.builtIn ? { emojis: room.emojis, stickers: room.stickers, gifs: room.gifs } : { emojis: ALL_EMOJIS, stickers: ALL_STICKERS, gifs: ALL_GIFS };
export const UPLOAD_PATTERN = /^\/uploads\/[a-f0-9-]{36}\.(jpg|png|gif|webp|webm|mp4|m4a|ogg)$/;
export const safeUploadUrl = value => UPLOAD_PATTERN.test(String(value || "")) ? String(value) : null;
export const IMAGE_TYPES = [{ ext: "jpg", magic: [0xFF, 0xD8, 0xFF] }, { ext: "png", magic: [0x89, 0x50, 0x4E, 0x47] }, { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] }, { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }];
export const AUDIO_TYPES = [{ ext: "webm", magic: [0x1A, 0x45, 0xDF, 0xA3] }, { ext: "ogg", magic: [0x4F, 0x67, 0x67, 0x53] }, { ext: "mp4", magic: null }];
export function matchesMediaType(buffer, type) { if (!type.magic) return buffer.length > 12 && String.fromCharCode(...buffer.slice(4, 8)) === "ftyp"; if (buffer.length < type.magic.length) return false; return type.magic.every((byte, index) => buffer[index] === byte); }
export function safeMediaUrl(value) { const candidate = String(value || "").trim(); if (/^\/gifs\/[a-z0-9-]+\.gif$/i.test(candidate)) return candidate; try { const url = new URL(candidate); return url.protocol === "https:" && ["media.giphy.com", "i.giphy.com", "media.tenor.com", "media1.tenor.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null; } catch { return null; } }
export const UPLOAD_CONTENT_TYPES = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", webm: "audio/webm", mp4: "audio/mp4", m4a: "audio/mp4", ogg: "audio/ogg" };
