# Third-party notices

This package invokes the `rtk` command-line tool as a subprocess. **No rtk code is bundled,
linked, or redistributed here** — nothing from rtk's sources is copied into `host.js`, `client.js`,
or any other file in this package. The plugin only spawns the `rtk` binary the user installed and
consumes its stdout.

The one rtk **artwork** file this package does ship is the project logo used as the settings-page
navigation icon (`icon.svg`, and the same bytes inlined into `client.js` as a data URI so the icon
renders without a filesystem read). It is unmodified rtk artwork: only its colour is applied at
render time, through a CSS mask — the shape and alpha channel are the upstream ones. See
[rtk artwork](#rtk-artwork) below.

## rtk (Rust Token Killer)

- Upstream: <https://github.com/rtk-ai/rtk>
- What this plugin uses: the CLI subcommands `rewrite` and `pipe`, plus the command filters those
  two subcommands route to. That surface is licensed **Apache-2.0**.
- What this plugin does **not** use: rtk's compression engine, plugin SDK, or proxy daemon. Those
  parts of rtk are licensed BUSL-1.1 (free for production use, no reselling as a paid product,
  converting to Apache-2.0 on 2030-09-09). The plugin never links them and never ships them, so
  that license boundary does not reach this package.
- The CLI itself is a separate program under the user's control. Installing, upgrading, and
  licensing rtk is the user's relationship with rtk, not with this plugin.

## rtk artwork

- Source: the rtk brand mark published at <https://www.rtk-ai.app/brand/> (512×512 PNG with alpha,
  15,524 bytes, sha256 `ef65a14dcafce1479844828f264c01a59c3fe4dfd944736a8c7d475dadfc4463`).
- License: the same **Apache-2.0** terms as the rtk repository above.
- How it is used: as the settings-page navigation icon. The published PNG is embedded verbatim —
  in `icon.svg` (a one-element SVG wrapper) and in `client.js` (a data URI used as a CSS mask so
  the mark takes the theme's foreground colour). No pixel, path, or alpha value is altered.
- Trademarks: Apache-2.0 §6 grants no trademark rights. The mark identifies the rtk project whose
  CLI this plugin drives; it is not used to endorse or rebrand this plugin. If the rtk maintainers
  object to the usage, the icon will be replaced.

## Bundled runtime dependencies

| Package | License | Why it is here |
| --- | --- | --- |
| `@jayyuen66/dsh-plugin-shared` | MIT | Shared build layer and settings-card primitives. Inlined into `client.js` at build time; `react` and `zod` stay external to the host's module table. |
| `zod` | MIT | Strict codecs for the settings card and the statistics records. Externalized in `client.js`; the host supplies the single instance. |

## Host packages

`@deepseek-ai/*` packages appear only under `peerDependencies` / `devDependencies`, never under
`dependencies`, and none of their code is redistributed by this package.
