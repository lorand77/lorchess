"use strict";

// `npm run promo:new` — mint membership promo codes, and list the ones that
// exist. Codes are nine random digits and each works exactly once; redemption
// is enforced in the database, not here (see src/membership/routes.js).
//
//   npm run promo:new                 mint 10 and print them
//   npm run promo:new -- --count 3    mint 3
//   npm run promo:new -- --list       show every code and who used it
//
// Safe to run while the server is up: better-sqlite3 in WAL mode handles the
// concurrent write. Codes are printed once, here — nothing else ever displays
// an unredeemed code, so keep the output.

const { randomInt } = require("crypto");
const queries = require("./queries");

// Nine digits, never leading zero, from a CSPRNG rather than Math.random:
// these are bearer tokens, however short.
function newCode() {
  return String(randomInt(100000000, 1000000000));
}

function parseArgs(argv) {
  const out = { count: 10, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") out.list = true;
    else if (argv[i] === "--count") {
      out.count = parseInt(argv[++i], 10);
      if (!Number.isInteger(out.count) || out.count < 1 || out.count > 1000) {
        console.error("error: --count must be between 1 and 1000");
        process.exit(2);
      }
    } else {
      console.error("error: unknown argument " + argv[i]);
      console.error("usage: npm run promo:new -- [--count N] [--list]");
      process.exit(2);
    }
  }
  return out;
}

function list() {
  const rows = queries.listPromoCodes.all();
  if (!rows.length) {
    console.log("No promo codes yet. Run `npm run promo:new` to mint some.");
    return;
  }
  const free = rows.filter((r) => !r.redeemed_at).length;
  console.log(`${rows.length} code(s), ${free} still unused:\n`);
  for (const r of rows) {
    console.log(
      "  " + r.code + "  " +
      (r.redeemed_at ? "used by " + r.redeemed_by + " on " + r.redeemed_at : "unused")
    );
  }
}

function mint(count) {
  const made = [];
  // INSERT OR IGNORE means a collision is a no-op rather than an error, so just
  // try again until we have as many as were asked for.
  for (let guard = 0; made.length < count && guard < count * 50; guard++) {
    const code = newCode();
    if (queries.insertPromoCode.run(code).changes === 1) made.push(code);
  }
  if (made.length < count) {
    console.error("error: could not generate enough unique codes");
    process.exit(1);
  }
  console.log(`Minted ${made.length} promo code(s). Each one works exactly once:\n`);
  for (const code of made) console.log("  " + code);
  console.log("\nThis is the only time they are printed — save them somewhere.");
}

const args = parseArgs(process.argv.slice(2));
if (args.list) list();
else mint(args.count);
