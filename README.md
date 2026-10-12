# kiln-text-image-to-glb

A Claude Code workflow that turns a text brief and/or reference image into a reviewed GLB using [Kiln](https://github.com/instruktlabs/kiln), plus a static gallery that shows the results.

**Live gallery:** https://sumeethedral.github.io/kiln-text-image-to-glb/

## How it works

Kiln runs locally through your coding agent (MCP/CLI), so generation is not hosted. The skill [`kiln-text-image-to-glb`](.claude/skills/kiln-text-image-to-glb/SKILL.md) chains Kiln's own author, refine and QA skills:

1. Intake: read the image or brief, write a short spec (parts, scale, materials, what the image cannot show).
2. Author a procedural Kiln program and render a six-view sheet.
3. Compare against the reference, then refine with anchored edits (max 3 rounds).
4. QA, then deliver `asset.glb`, `asset.kiln.js`, the contact sheet and a report.

A reference image guides silhouette, proportions and materials. It does not recover hidden sides or exact geometry.

## Set up

Needs Node 20.15+ or 22.2+.

```bash
scripts/setup.sh ~/kiln-workspace
cd ~/kiln-workspace && claude
```

This installs `@instruktlabs/kiln` (outside the workspace), creates a Claude Code workspace with `kiln-init --harness claude`, and copies this skill in. Accept the project and MCP trust prompts, then ask:

> Use kiln-text-image-to-glb on ./photo.jpg

## Publish a result to the gallery

```bash
node scripts/add-asset.mjs camping-lantern "Camping lantern" "Brief shown on the page" asset.glb sheet.png asset.kiln.js
git add site && git commit -m "Add asset" && git push
```

Pushing to `main` redeploys `site/` to GitHub Pages. The viewer uses three.js with a WebGL / WebGPU toggle and live frame stats.

## Credits

Kiln is by Instrukt Labs (MIT). This repo only adds a workflow skill and a gallery around it.
