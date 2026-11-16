/**
 * The Draw & Guess word list.
 *
 * Curated, not a dictionary dump: every entry has to be drawable with a finger on a phone in under two minutes,
 * and safe to show on an 18+ site that still wants a chat-safe tone. It is bundled rather than fetched, so a
 * round never waits on the network and there is no runtime dependency to fail (see GAMES.md).
 *
 * Rules for adding a word: a concrete noun that one line can convey, no proper names, no words that need text
 * to be understood, nothing sexual, violent or political, and none that are only funny because they are rude.
 */
export const DRAW_WORDS = [
  // animals
  "cat", "dog", "horse", "cow", "pig", "sheep", "goat", "duck", "chicken", "owl",
  "eagle", "penguin", "fish", "shark", "whale", "dolphin", "octopus", "crab", "snail", "butterfly",
  "bee", "spider", "snake", "frog", "turtle", "rabbit", "mouse", "elephant", "giraffe", "lion",
  "tiger", "monkey", "bear", "camel", "zebra", "kangaroo", "hedgehog", "bat", "fox", "wolf",
  // food and drink
  "apple", "banana", "cherry", "grape", "lemon", "orange", "peach", "strawberry", "watermelon", "pineapple",
  "carrot", "potato", "tomato", "onion", "pepper", "mushroom", "bread", "cheese", "egg", "pizza",
  "burger", "sandwich", "soup", "salad", "pasta", "rice", "cake", "cookie", "chocolate", "ice cream",
  "coffee", "tea", "juice", "milk", "water", "honey", "popcorn", "pretzel", "pancake", "donut",
  // home and objects
  "chair", "table", "bed", "sofa", "door", "window", "stairs", "lamp", "mirror", "clock",
  "key", "lock", "brush", "comb", "towel", "soap", "toothbrush", "umbrella", "backpack", "wallet",
  "glasses", "watch", "ring", "hat", "shoe", "sock", "glove", "scarf", "jacket", "shirt",
  "camera", "phone", "laptop", "keyboard", "mouse pad", "television", "radio", "speaker", "headphones", "battery",
  "candle", "basket", "bucket", "broom", "hammer", "screwdriver", "ladder", "paintbrush", "scissors", "needle",
  // nature and weather
  "sun", "moon", "star", "cloud", "rain", "snow", "wind", "storm", "rainbow", "lightning",
  "tree", "leaf", "flower", "rose", "cactus", "grass", "mountain", "volcano", "river", "lake",
  "sea", "beach", "island", "desert", "forest", "cave", "waterfall", "fire", "ice", "sand",
  // transport
  "car", "bus", "train", "bicycle", "motorcycle", "truck", "taxi", "boat", "ship", "plane",
  "helicopter", "rocket", "balloon", "skateboard", "scooter", "tractor", "submarine", "canoe", "sled", "traffic light",
  // places and buildings
  "house", "castle", "tower", "bridge", "church", "school", "hospital", "shop", "market", "library",
  "museum", "station", "airport", "hotel", "farm", "barn", "lighthouse", "windmill", "tent", "well",
  // people and roles
  "doctor", "teacher", "chef", "farmer", "pirate", "knight", "wizard", "clown", "astronaut", "diver",
  "singer", "dancer", "artist", "detective", "firefighter", "police officer", "pilot", "judge", "king", "queen",
  // sport and play
  "football", "basketball", "tennis", "golf", "swimming", "boxing", "skating", "skiing", "surfing", "climbing",
  "chess", "dice", "cards", "kite", "puzzle", "swing", "trampoline", "trophy", "goal", "racket",
  // body and health
  "hand", "foot", "eye", "ear", "nose", "mouth", "hair", "tooth", "heart", "brain",
  "smile", "frown", "thumb", "knee", "elbow",
  // music and art
  "guitar", "piano", "drum", "violin", "trumpet", "flute", "microphone", "stage", "painting", "sculpture",
  // misc everyday
  "balloon animal", "bubble", "shadow", "footprint", "puddle", "knot", "net", "rope", "chain", "wheel",
  "anchor", "compass", "map", "flag", "ticket", "envelope", "stamp", "newspaper", "book", "pencil",
  "paper clip", "stapler", "tape", "glue", "magnet", "spring", "gear", "funnel", "sponge", "cushion",
  "blanket", "pillow", "curtain", "carpet", "vase", "pot", "pan", "kettle", "toaster", "fridge",
  "clock tower", "fountain", "statue", "bench", "fence", "gate", "mailbox", "street lamp", "bus stop", "phone booth",
  "snowman", "scarecrow", "kite string", "sandcastle", "bonfire", "fireworks", "parachute", "hammock", "treehouse", "greenhouse"
];

/** A guess split into words, so "It's a cat!" becomes ["it", "a", "cat"] and punctuation is ignored. */
const drawTokens = value => String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * True when the guess contains the word as whole words: "I think it's a hammer" matches "hammer", while
 * "concatenate" does not match "cat". A multi-word word ("ice cream") only matches when its words appear
 * together and in order, which is what stops "cream" alone from giving away half of it.
 */
export const drawGuessMatches = (guess, word) => {
  const haystack = drawTokens(guess), needle = drawTokens(word);
  if (!needle.length || !haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
};

/** How much of the word to show: first letter stays, the rest becomes spaces between dashes. */
export const drawMask = word => String(word || "").split("").map((character, index) => (index === 0 || character === " " ? character : "_")).join(" ");
