"use strict";

// `npm run db:reset` — delete the SQLite files and recreate a fresh schema.
// Destructive: drops all users/games/moves. Dev convenience only.

const fs = require("fs");
const config = require("./../config");

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const file = config.DB_PATH + suffix;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log("removed", file);
  }
}

// Importing index.js recreates the file, applies the schema, and seeds AI user.
require("./index");
console.log("Database reset:", config.DB_PATH);
