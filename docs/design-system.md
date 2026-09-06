# Console design system

The console uses React with local shadcn-style components built from Radix UI, Class Variance Authority, and Lucide icons. Its original sidebar, paper surfaces, green accents, typography, spacing, and responsive grids remain the design foundation.

`web/style.css` owns the existing layout and semantic light/dark color values. `web/design-system.css` exposes those values to Tailwind 4 utilities without adding a reset that changes the established layout. The build compiles those utilities with PostCSS and bundles production React with esbuild; end users need no frontend toolchain.

Use `Button`, `Card`, and the dropdown primitives in `web/components/ui/` for shared controls. Use semantic colors such as `bg-card` and `text-card-foreground` instead of literal colors in new components. The theme menu supports light, dark, and the system preference, and persists the choice in browser local storage.

`components.json` maps the shadcn CLI to this source tree. When adding a component, review generated dependencies and styles, preserve the existing tokens, and use `.js` extensions in local TypeScript imports for the repository's NodeNext policy. Run `npm run check`, `npm test`, and `npm run test:browser -- --project=chromium` after a behavioral change.

Configuration references: [shadcn components.json](https://ui.shadcn.com/docs/components-json) and [Tailwind with PostCSS](https://tailwindcss.com/docs/installation/using-postcss). Shared component wrappers are maintained as repository source, rather than fetched at application startup.
