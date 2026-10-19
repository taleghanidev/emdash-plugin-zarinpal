# End-to-end runs

These scripts drive a real EmDash site with this plugin installed, and the real
`sandbox.zarinpal.com`, in headless Chromium. They also write the README screenshots.

1. Create a site, install the plugin and copy `examples/astro/src` into it
   (see the main README). On a Cloudflare template, local dev cannot reach
   Zarinpal (see Known limitations), so use the Node.js setup.
2. Put `EMDASH_ENCRYPTION_KEY` and `ZARINPAL_API_KEY` in the site's `.env`,
   export them, and start `pnpm dev --port 4321`. Local dev exposes EmDash's
   dev-bypass sign-in, which the scripts use.
3. Run:

```sh
npm install && npx playwright install chromium
node e2e.mjs ../docs/screenshots /path/to/site/.env
node abandon.mjs ../docs/screenshots /path/to/site/.env
```

`e2e.mjs` configures the plugin (sandbox merchant ID, site URL, API key),
creates a payment link, pays it in the sandbox, cancels a server checkout, and
checks the server routes. `abandon.mjs` pays at Zarinpal without returning to
the site and then recovers the payment with **Verify now**. Use a fresh
database for each full run, since the scripts use fixed order IDs.
