// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// TODO: change to your production domain once the Cloudflare Pages project is
// connected (e.g. https://wasmpeg.dev). Used for canonical URLs + sitemap (SEO).
const SITE = 'https://wasmpeg.pages.dev';
const DESCRIPTION =
    'FFmpeg for the browser, built for the decode → display loop. Get RGBA frames, ' +
    'audio, and metadata from a 2.9 MB gzipped WASM — no SharedArrayBuffer, no COOP/COEP headers.';

export default defineConfig({
    site: SITE,
    integrations: [
        starlight({
            title: 'wasmpeg',
            description: DESCRIPTION,
            logo: { src: './src/assets/logo.svg', replacesTitle: false },
            favicon: '/favicon.svg',
            social: [
                { icon: 'github', label: 'GitHub', href: 'https://github.com/wasmpeg/wasmpeg' },
            ],
            editLink: {
                baseUrl: 'https://github.com/wasmpeg/wasmpeg/edit/main/site/',
            },
            lastUpdated: true,
            customCss: ['./src/styles/global.css'],
            components: {
                // Match the docs header branding to the landing/team navbar.
                SiteTitle: './src/components/StarlightSiteTitle.astro',
            },
            head: [
                { tag: 'meta', attrs: { property: 'og:image', content: SITE + '/og.png' } },
                { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
                { tag: 'meta', attrs: { name: 'twitter:image', content: SITE + '/og.png' } },
            ],
            sidebar: [
                { label: '← Back to home', link: '/' },
                {
                    label: 'Getting started',
                    items: [
                        { label: 'Introduction', slug: 'start/introduction' },
                        { label: 'How it works', slug: 'start/how-it-works' },
                        { label: 'Installation', slug: 'start/installation' },
                        { label: 'Quick start', slug: 'start/quick-start' },
                        { label: 'The three APIs', slug: 'start/apis' },
                        { label: 'Browser & environment support', slug: 'start/support' },
                    ],
                },
                {
                    label: 'Guides',
                    items: [
                        { label: 'FFmpeg → wasmpeg', slug: 'guides/ffmpeg-recipes', badge: 'Start here' },
                        { label: 'Decode video frames', slug: 'guides/decode-video' },
                        { label: 'Decode audio to PCM', slug: 'guides/decode-audio' },
                        { label: 'Probe metadata', slug: 'guides/probe' },
                        { label: 'Scale & filter a frame', slug: 'guides/scale-filter' },
                        { label: 'Encode & thumbnails', slug: 'guides/encode' },
                        { label: 'Examples', slug: 'guides/examples' },
                        { label: 'Migrating from @ffmpeg/ffmpeg', slug: 'guides/migrating-from-ffmpeg-wasm' },
                        { label: 'Troubleshooting & FAQ', slug: 'guides/troubleshooting' },
                    ],
                },
                {
                    label: 'Framework guides',
                    items: [
                        { label: 'Vite', slug: 'guides/frameworks/vite' },
                        { label: 'Next.js', slug: 'guides/frameworks/nextjs' },
                        { label: 'Vue', slug: 'guides/frameworks/vue' },
                        { label: 'Svelte', slug: 'guides/frameworks/svelte' },
                        { label: 'Node.js', slug: 'guides/frameworks/nodejs' },
                    ],
                },
                {
                    label: 'API reference',
                    items: [
                        { label: 'High-level — wasmpeg', slug: 'reference/high-level' },
                        { label: 'FFmpeg class', slug: 'reference/ffmpeg-class' },
                        { label: 'Low-level — gpu', slug: 'reference/gpu' },
                        { label: 'Command reference', slug: 'reference/exec-commands' },
                        { label: 'C ABI', slug: 'reference/c-abi' },
                        { label: 'Error codes', slug: 'reference/errors' },
                    ],
                },
                {
                    label: 'Building',
                    items: [
                        { label: 'From source', slug: 'build/from-source' },
                        { label: 'Configuration & presets', slug: 'build/configuration' },
                    ],
                },
                {
                    label: 'More',
                    items: [
                        { label: 'Compatibility (FATE)', slug: 'compatibility' },
                        { label: 'Codec & format support', slug: 'codecs' },
                        { label: 'Filter reference', slug: 'filters' },
                        { label: 'WebGPU (experimental)', slug: 'webgpu' },
                    ],
                },
            ],
        }),
        sitemap(),
    ],
    vite: {
        plugins: [tailwindcss()],
    },
});
