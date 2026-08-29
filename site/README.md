# wasmpeg.dev

The wasmpeg documentation site — [Hugo](https://gohugo.io) (extended), no npm dependencies.

## Develop

```sh
hugo server
```

## Build

```sh
node scripts/gen-site-data.mjs   # refresh FATE data from COMPAT.md / CORRECTNESS.md
hugo --minify
```

Output lands in `public/`.

## Editing content

Everything under `content/` is plain markdown. Site-wide values (sizes, coverage
percentages, package names, links) live in the `[params]` block of `hugo.toml` and are
referenced from markdown as `{{%/* param "sizeGzMB" */%}}` — change the number once and
every page follows.

The FATE tables on the compatibility page are generated from the repo's `COMPAT.md` and
`CORRECTNESS.md` by `scripts/gen-site-data.mjs`, which writes `data/*.json`.

## Deploying to Cloudflare Pages

- Build command: `node scripts/gen-site-data.mjs && hugo --minify`
- Output directory: `public`
- Root directory: `site`
- Environment variable: `HUGO_VERSION = 0.140.2`
