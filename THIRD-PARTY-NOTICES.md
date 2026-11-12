# Third-party notices

## Shipped with the launcher

| Component | Use | License |
|---|---|---|
| [uv](https://github.com/astral-sh/uv) 0.13.8 by Astral | Installs Python and the bot's packages; bundled as a separate program | MIT or Apache-2.0 |
| ZDBF Grotesk, a renamed Latin subset of [Mona Sans](https://github.com/github/mona-sans) | Interface font | SIL Open Font License 1.1, see `public/fonts/LICENSES.txt` |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | Console and code font | SIL Open Font License 1.1, see `public/fonts/LICENSES.txt` |
| [Tauri](https://tauri.app) and its plugins | Application framework | MIT or Apache-2.0 |
| [React](https://react.dev), [Zustand](https://github.com/pmndrs/zustand), [react-markdown](https://github.com/remarkjs/react-markdown) and the unified/remark/rehype packages, [github-slugger](https://github.com/Flet/github-slugger), [MiniSearch](https://github.com/lucaong/minisearch), [Lucide](https://lucide.dev) | Interface | MIT (Lucide: ISC) |
| [GSAP](https://gsap.com) | Animation of the bot state mark | Standard "No Charge" GSAP License |
| Rust crates (tokio, reqwest, rustls, serde, toml_edit, tar, flate2, zip, sha2, regex and others) | Backend | MIT and/or Apache-2.0 (some BSD-3-Clause, ISC, Zlib or Unicode-3.0) |

The full license texts of the npm and Cargo dependencies are in their packages; `cargo deny list` and
`pnpm licenses list` print them.

## Downloaded when you use a feature

These are downloaded from their publishers on your computer when needed. They are not part of the launcher's files.

| Component | When | License |
|---|---|---|
| [ZDBF V2](https://github.com/TheHolyOneZ/ZDBF-V2) | Installing or updating a bot | Apache-2.0 (marketplace client: ZSync Marketplace License) |
| CPython 3.13 from [python-build-standalone](https://github.com/astral-sh/python-build-standalone), through uv | Installing a bot | Python Software Foundation License and the licenses of the bundled libraries |
| Python packages ZDBF needs, from PyPI | Installing or updating a bot | Their own licenses |
| PHP 8.5, a static build from [static-php-cli](https://github.com/crazywhalecc/static-php-cli) (Linux, macOS) or the official build from [windows.php.net](https://windows.php.net) | Setting up the local web dashboard | PHP License and the licenses of the bundled libraries; static-php-cli is MIT |
