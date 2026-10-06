import starlight from "@astrojs/starlight";
import sentry from "@sentry/astro";
import sentryStarlightTheme, {
  monochromeCodeTheme,
  sentryAgentMarkdown,
} from "@sentry/starlight-theme";
import { defineConfig } from "astro/config";

// Allow base path override via environment variable for PR previews
const base = process.env.DOCS_BASE_PATH || "/";

export default defineConfig({
  site: "https://cli.sentry.dev",
  base,
  markdown: {
    smartypants: false,
    shikiConfig: {
      theme: monochromeCodeTheme,
    },
  },
  // Generate sourcemaps for Sentry. "hidden" produces .map files without
  // adding //# sourceMappingURL comments to the output (the debug IDs
  // injected post-build by `sentry sourcemap inject` are used instead).
  //
  // Astro 6 / Vite 7 reads `sourcemap` from
  // `vite.environments.{client,ssr}.build.sourcemap` (Environments API),
  // not the legacy top-level `vite.build.sourcemap`.
  vite: {
    environments: {
      client: { build: { sourcemap: "hidden" } },
      ssr: { build: { sourcemap: "hidden" } },
    },
  },
  integrations: [
    sentry({
      project: "cli-website",
      org: "sentry",
      environment: process.env.PUBLIC_SENTRY_ENVIRONMENT ?? "development",
      // Note: @sentry/astro v10 does not support the `release` build-time
      // option (todo(v11) in the source). Release is set in Sentry.init()
      // via PUBLIC_SENTRY_RELEASE / SENTRY_RELEASE env vars instead.
      //
      // Disable the plugin's sourcemap upload — it pulls in @sentry/cli
      // (20+ MB binary download). We use our own CLI post-build instead
      // (see CI workflow: `sentry sourcemap inject` + `sentry sourcemap upload`).
      sourceMapsUploadOptions: { enabled: false },
    }),
    starlight({
      title: "Sentry CLI",
      favicon: "/favicon.svg",
      logo: {
        // The site is dark-only (the theme maps light + dark to the same dark
        // palette), so a single white logo is used for both — a dark-marks
        // variant would be invisible on the always-dark header.
        src: "./src/assets/logo.svg",
        replacesTitle: true,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/getsentry/toolkit",
        },
      ],
      plugins: [sentryStarlightTheme(), sentryAgentMarkdown()],
      components: {
        PageFrame: "./src/components/PageFrame.astro",
        Header: "./src/components/Header.astro",
        // The custom landing page should not render the docs theme footer.
        Footer: "./src/components/Footer.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      head: [
        // PNG favicon fallback for browsers without SVG-favicon support.
        // (Starlight's `favicon` option emits the SVG link; this adds the raster.)
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon.png",
            type: "image/png",
            sizes: "256x256",
          },
        },
        // Overscroll easter egg - bottom of page, only on /cli route
        {
          tag: "script",
          content: `
            (function() {
              let overscrollEl;
              let pullDistance = 0;
              let touchStartY = 0;
              let isAtBottom = false;
              
              function isLandingPage() {
                const path = window.location.pathname;
                // Works with both / (prod) and /pr-preview/pr-XX (preview)
                return path === '/' || 
                       /^\\/\\_preview\\/pr-(\\d+|main)\\/?$/.test(path);
              }
              
              function checkAtBottom() {
                const scrollTop = window.scrollY || document.documentElement.scrollTop;
                const scrollHeight = document.documentElement.scrollHeight;
                const clientHeight = document.documentElement.clientHeight;
                return scrollTop + clientHeight >= scrollHeight - 5;
              }
              
              function createOverscrollMessage() {
                if (!isLandingPage()) return;
                var command = 'curl https://cli.sentry.dev/install -fsS | bash';
                overscrollEl = document.createElement('div');
                overscrollEl.className = 'overscroll-message';
                overscrollEl.innerHTML = '<span>You made it to the end. Might as well give it a try → <code class="overscroll-copy-cmd" title="Click to copy">' + command + '</code></span>';
                document.body.appendChild(overscrollEl);
                var codeEl = overscrollEl.querySelector('.overscroll-copy-cmd');
                codeEl.addEventListener('click', function() {
                  if (!navigator.clipboard) return;
                  navigator.clipboard.writeText(command).then(function() {
                    codeEl.textContent = 'copied!';
                    setTimeout(function() { codeEl.textContent = command; }, 1500);
                  }).catch(function() {});
                });
              }
              
              function updateOverscroll(distance) {
                if (!overscrollEl) return;
                const clampedDistance = Math.min(Math.max(distance, 0), 50);
                const opacity = Math.min(clampedDistance / 15, 1);
                const translateY = Math.min(clampedDistance * 2.5, 120);
                overscrollEl.style.opacity = opacity;
                overscrollEl.style.transform = 'translateX(-50%) translateY(-' + translateY + 'px)';
              }
              
              function handleTouchStart(e) {
                if (!isLandingPage()) return;
                touchStartY = e.touches[0].clientY;
                isAtBottom = checkAtBottom();
              }
              
              function handleTouchMove(e) {
                if (!isLandingPage() || !isAtBottom) return;
                const touchY = e.touches[0].clientY;
                pullDistance = touchStartY - touchY;
                if (pullDistance > 0 && checkAtBottom()) {
                  updateOverscroll(pullDistance);
                }
              }
              
              function handleTouchEnd() {
                pullDistance = 0;
                updateOverscroll(0);
              }
              
              function handleWheel(e) {
                if (!isLandingPage()) return;
                if (checkAtBottom() && e.deltaY > 0) {
                  pullDistance = Math.min(pullDistance + e.deltaY * 0.8, 50);
                  updateOverscroll(pullDistance);
                  clearTimeout(window.overscrollTimeout);
                  window.overscrollTimeout = setTimeout(function() {
                    pullDistance = 0;
                    updateOverscroll(0);
                  }, 5000);
                } else if (e.deltaY < 0) {
                  clearTimeout(window.overscrollTimeout);
                  pullDistance = 0;
                  updateOverscroll(0);
                }
              }
              
              document.addEventListener('DOMContentLoaded', function() {
                createOverscrollMessage();
                document.addEventListener('touchstart', handleTouchStart, { passive: true });
                document.addEventListener('touchmove', handleTouchMove, { passive: true });
                document.addEventListener('touchend', handleTouchEnd, { passive: true });
                document.addEventListener('wheel', handleWheel, { passive: true });
              });
            })();
          `,
        },
        // Add fonts
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.googleapis.com",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap",
          },
        },
        // Plausible analytics — defer keeps it off the critical path
        {
          tag: "script",
          attrs: {
            defer: true,
            "data-domain": "cli.sentry.dev",
            src: "https://plausible.io/js/script.js",
          },
        },
        // Open Graph images for social sharing
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://cli.sentry.dev/og-image.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://cli.sentry.dev/og-image-twitter.png",
          },
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "" },
            { label: "Installation", slug: "getting-started" },
            { label: "Migrating from v3", slug: "migrating-from-v3" },
            { label: "Self-Hosted", slug: "self-hosted" },
            { label: "Configuration", slug: "configuration" },
            { label: "Library Usage", slug: "library-usage" },
          ],
        },
        {
          label: "Commands",
          items: [{ autogenerate: { directory: "commands" } }],
        },
        {
          label: "Resources",
          items: [
            { label: "Agentic Usage", slug: "agentic-usage" },
            { label: "Contributing", slug: "contributing" },
          ],
        },
      ],
      customCss: ["./src/styles/cli.css"],
    }),
  ],
});
