"use strict";

// Central place for env-driven constants. Milestones 2+ add SESSION_SECRET,
// DB_PATH, etc. — for M1 we only need the HTTP port.
module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
};
