'use strict';

// The piece sets, board styles and fog styles a player can pick under Customize. Shared
// by the server, which only stores a key it finds here (settings/routes.js),
// and the browser, where theme.js turns the keys into image URLs and the
// `data-board-style` that styles.css draws the squares by.
//
// A piece set is twelve images in `dir`, named by colour and type as `files`
// spells them. A board style either keeps the player's own square colours
// (`ownColours`), or brings textures of its own, `/assets/boards/<key>-light.svg`
// and `-dark.svg` (drawn by tools/boards/build.js), with `light` and `dark` the
// colours they average to, which the coordinates and the small boards use.
// Every style but Flat gives each square its own slight shade.

const PIECE_SETS = [
  // Cburnett (JohnPablok's improved set, CC BY-SA 3.0: docs/licenses.md).
  { key: 'cburnett', label: 'Classic', dir: '/assets/', files: (c, t) => `${c}_${CBURNETT_FILES[t]}_1x_ns.png` },
  // Ours, drawn by tools/pieces/build.js.
  { key: 'lorchess', label: 'LorChess Staunton', dir: '/assets/pieces/lorchess/', files: (c, t) => `${c}${t.toUpperCase()}.svg` },
];
const CBURNETT_FILES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const DEFAULT_PIECE_SET = 'cburnett';

const BOARD_STYLES = [
  { key: 'flat', label: 'Flat', ownColours: true },
  { key: 'shaded', label: 'Shaded', ownColours: true },
  { key: 'walnut', label: 'Walnut', light: '#dbb985', dark: '#80522c' },
  { key: 'marble', label: 'Marble', light: '#e8e4da', dark: '#79897f' },
  { key: 'slate', label: 'Slate', light: '#bdc3c9', dark: '#515c67' },
];
const DEFAULT_BOARD_STYLE = 'flat';

// How Fog of War draws a square its player can't see: flat grey, or a bank
// of cloud laid across the board (/assets/boards/fog-clouds.svg) with soft
// edges where it meets what is seen.
const FOG_STYLES = [
  { key: 'simple', label: 'Simple' },
  { key: 'clouds', label: 'Clouds' },
];
const DEFAULT_FOG_STYLE = 'simple';

// Maps, not plain objects: these keys come off the wire (see variants.js).
const PIECE_SETS_BY_KEY = new Map(PIECE_SETS.map((s) => [s.key, s]));
const BOARD_STYLES_BY_KEY = new Map(BOARD_STYLES.map((s) => [s.key, s]));
const FOG_STYLES_BY_KEY = new Map(FOG_STYLES.map((s) => [s.key, s]));

function resolvePieceSet(key) {
  return PIECE_SETS_BY_KEY.has(key) ? key : DEFAULT_PIECE_SET;
}
function resolveBoardStyle(key) {
  return BOARD_STYLES_BY_KEY.has(key) ? key : DEFAULT_BOARD_STYLE;
}
function resolveFogStyle(key) {
  return FOG_STYLES_BY_KEY.has(key) ? key : DEFAULT_FOG_STYLE;
}

// The image for a piece of colour 'w' or 'b' and type 'k'...'p' in a set.
function pieceUrl(setKey, c, t) {
  const set = PIECE_SETS_BY_KEY.get(resolvePieceSet(setKey));
  return set.dir + set.files(c, t);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIECE_SETS, BOARD_STYLES, FOG_STYLES, DEFAULT_PIECE_SET, DEFAULT_BOARD_STYLE, DEFAULT_FOG_STYLE,
    PIECE_SETS_BY_KEY, BOARD_STYLES_BY_KEY, FOG_STYLES_BY_KEY,
    resolvePieceSet, resolveBoardStyle, resolveFogStyle, pieceUrl,
  };
}
