"use strict";

// src/auth/usernamePolicy.js: which otherwise well-formed names registration
// refuses, and which ordinary names that look close must still get through.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { usernameProblem } = require("../../src/auth/usernamePolicy");

function expectAll(names, problem) {
  for (const name of names) assert.equal(usernameProblem(name), problem, name);
}

describe("usernameProblem", () => {
  test("shape: at least one letter, underscores only between characters", () => {
    expectAll(["___", "12345", "_alice", "alice_", "al__ice"], "shape");
    expectAll(["al_ice", "a1b2c3"], null);
  });

  test("lor anywhere, digits read as letters", () => {
    expectAll([
      "Lorenzo", "Taylor", "sailor", "tailor", "color", "Lord", "Gloria", "glory", "Florida",
      "explorer", "valor", "chlorine", "L0rd", "1or", "L0rd2", "Tay_lor", "lorand",
      "LorChess_fan", "Lor_Fish", "LorFish", "lorfish",
    ], "lor");
    expectAll(["Floor", "Moor", "Laura", "Lior"], null);
  });

  test("reserved: staff words anywhere, short ones as parts, UI labels whole", () => {
    expectAll([
      "ChessBot", "Play_AI", "M0d", "Root42", "Wh1te", "SysAdmin99", "the_admin", "Big_Mod",
      "BigMOD", "guest", "Gu3st", "anonymous", "black", "Stockfish", "player", "StaffPick",
      "Official_FIDE", "support_desk", "dev_guy",
    ], "reserved");
    expectAll(["Modern", "Devon", "Botany", "White_Knight", "BlackCat", "guest_star", "Bigmod"], null);
  });

  test("offensive: anywhere words through every reading, short words as parts", () => {
    expectAll([
      "F_u_c_k", "Fuuuck", "5h1t", "BigAss", "ass_man", "N1gg4", "kkkk", "a55", "Tits_4U",
      "shitake_shit", "Yamashita_fuck", "p1ss_off", "g00k", "semen_7", "sexy_girl",
    ], "offensive");
  });

  test("words that merely contain a blocked word get through", () => {
    expectAll([
      "Scunthorpe_FC", "Classic", "Cockpit", "Hitchcock", "Dickens", "Analyst", "Essex",
      "Spice", "Raccoon", "Title", "Grape", "Therapist", "Penistone", "Shiitake", "Kinoshita",
      "Pistons", "Gokhan", "Niger", "Nigeria", "Snigger", "swanky", "Montenegro",
    ], null);
  });

  test("numbers and chess squares are not read as letters", () => {
    // Read digit by digit, 1995 is "iggs": Ryan1995 would hold a slur.
    expectAll(["Ryan1995", "Erin_1999", "Dan_199", "bob_41", "Rook_A1", "Knight_E4"], null);
    // A number dropped, what is left is still read as a whole: Guest_1234.
    expectAll(["Guest_1234", "White2024"], "reserved");
  });

  test("the known gap: run-together short words are not caught", () => {
    expectAll(["bigass", "Bigdick", "Tits4U"], null);
  });

  test("ordinary names pass", () => {
    expectAll(["alice", "bob_42", "carol", "MagnusFan", "e4_enjoyer", "Queen_Gambit"], null);
  });
});
