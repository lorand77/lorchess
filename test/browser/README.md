# Browser regressions

These optional tests use real Chromium against a temporary database. They are
separate from `npm test` and do not add dependencies to the application.
Point them at an existing `playwright-core` installation and Chromium binary:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core CHROMIUM_PATH=/path/to/chromium node --test test/browser/*.test.cjs
```

If Playwright and its browser are already on the standard resolution paths,
the environment variables can be omitted.

Run the files one at a time with `--test-concurrency=1`. Several of them open
two, three or four browser contexts at once (`bughouse.four.test.cjs` is a whole
match between four people), and running every file in parallel can exhaust
the memory of a small machine, which shows up as timeouts rather than errors.
