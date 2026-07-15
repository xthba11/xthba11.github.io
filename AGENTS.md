# Project Notes

## Overview

This repository is a Hexo static blog for embedded systems and Linux/network programming notes.

- Framework: Hexo 7.x
- Theme: Butterfly, configured in `_config.butterfly.yml`
- Content: Markdown posts under `source/_posts/`
- Generated output: `public/`
- Deployment: GitHub Pages workflow in `.github/workflows/deploy.yml`

## Common Commands

Run commands from this directory:

```bash
npm install
npm run server
npm run build
npm run clean
```

The GitHub Actions workflow uses `npm ci`, so keep `package-lock.json` committed.

## Editing Guidelines

- Put new posts in `source/_posts/`, preferably following the existing Chinese category folder structure.
- Use Hexo front matter matching the examples in `README.md` and `SPEC.md`.
- Main site settings live in `_config.yml`.
- Theme/navigation/search/comments/statistics settings live in `_config.butterfly.yml`.
- Do not edit generated files in `public/`; rebuild them with Hexo.
- Keep `node_modules/`, `public/`, logs, cache, and deployment output out of version control.

## Verification

Before handing off content or configuration changes, run:

```bash
npm run build
```

If `hexo: Permission denied` appears after extracting a zip on Linux, fix the local executable bit:

```bash
chmod +x node_modules/.bin/hexo node_modules/hexo/bin/hexo
```
