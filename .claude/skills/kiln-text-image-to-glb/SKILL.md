---
name: kiln-text-image-to-glb
description: End-to-end workflow that turns a text brief and/or reference image into a reviewed GLB with Kiln. Use when the user gives a description or an image and wants a 3D asset file, e.g. "make a GLB of this", "turn this photo into a 3D model", "model a camping lantern".
---

# Text / image to GLB

Orchestrates Kiln's own skills into one run. Do not duplicate their rules: read `kiln-author-asset` before writing source, `kiln-refine-asset` for every correction, and `kiln-qa-asset` before delivery.

A reference image guides silhouette, proportions, materials and art direction. It does not give hidden sides or exact geometry, and Kiln builds procedural source, not a scan. Say so in the report instead of implying a faithful reconstruction.

## Inputs

- A text brief, an image path, or both. If neither is usable, ask for one.
- Optional: destination (game engine, Blender, web), target scale, style, triangle or texture limits. Ask only when the answer would change the build; otherwise state the assumption you used.

## Run

Keep `KILN_PROGRESS.md` in the workspace: current `programRef`, iteration count, next action. Update it after every render or edit so a compacted context can resume.

1. **Intake.** Read the image (if any) and write a short spec in the progress file: subject, real-world scale, major parts named by role, materials, identity-defining features, and what the image cannot show. Text-only: derive the same list from the brief.
2. **Author.** Follow `kiln-author-asset`: `kiln_discover` for helpers, one program with named parameters, first render with the default six-view sheet. Save the source reference.
3. **Compare.** View the render next to the reference (or against the spec). List concrete mismatches, ordered by how much they hurt recognisability: silhouette, proportions, identity features, then materials.
4. **Refine.** Follow `kiln-refine-asset` with anchored edits, then re-render only the views that show the fix. Stop after 3 correction rounds, or sooner when no identity-defining mismatch remains. If a mismatch survives, report it; do not keep looping.
5. **QA.** Follow `kiln-qa-asset` for geometry, export fidelity and the destination checks that were named. Validation passing does not mean the result looks right: say which you checked.
6. **Deliver.** Write to `out/<asset-name>/`: `asset.glb`, `asset.kiln.js`, the final contact sheet PNG, and `REPORT.md`. All must come from the same final `programRef`; check `ok` and `files` on every export. Save to the collection when the collection tools exist, and call `kiln_present` if available.

## Report

`REPORT.md` and the final message state: the source and GLB paths, key design choices, what was compared against the reference and how it matched, unresolved mismatches, measured triangles/materials, and the assumptions made. No claim of fidelity beyond what the renders show.
