# wasmpeg docs site

The marketing landing page + documentation for wasmpeg, built with
[Astro](https://astro.build) and [Starlight](https://starlight.astro.build) and
deployed to **Cloudflare Pages**.

- Landing page: `src/pages/index.astro` (custom, Tailwind)
- Docs content: `src/content/docs/**` (Markdown / MDX — edit these to update the docs)
- Nav / sidebar / SEO: `astro.config.mjs`
- Brand styling: `src/styles/global.css`

## Local development

```sh
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # static output to ./dist
npm run preview  # serve the built ./dist
```

Requires Node ≥ 18.

## Deploying to Cloudflare Pages

The docs live in this `site/` subdirectory of the main repo. Connect the repo once in
the Cloudflare dashboard and CF rebuilds on every push — no GitHub Action or secrets
needed.

**Workers & Pages → Create → Pages → Connect to Git → select `wasmpeg/wasmpeg`**, then:

| Setting | Value |
|---------|-------|
| Production branch | `main` |
| Framework preset | `Astro` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory *(advanced)* | `site` |

To avoid rebuilding the site when only library code changes, set
**Settings → Builds → Build watch paths → Include paths** to `site/*`. CF will then only
trigger a deploy when something under `site/` changes.

### Custom domain

Since your DNS is already on Cloudflare: **Pages project → Custom domains → Set up a
domain**, point it at your apex/subdomain, and CF provisions the certificate. Then update
two things to that domain:

1. `SITE` in [`astro.config.mjs`](./astro.config.mjs) — drives canonical URLs + the sitemap.
2. The `<link rel="canonical">` / `og:*` URLs in [`src/pages/index.astro`](./src/pages/index.astro).

## Adding or editing docs

1. Add a `.md`/`.mdx` file under `src/content/docs/` (the path becomes the URL).
2. Give it `title` and `description` frontmatter.
3. Add it to the `sidebar` in `astro.config.mjs`.

Search (Pagefind) and the sitemap are generated automatically at build time.
