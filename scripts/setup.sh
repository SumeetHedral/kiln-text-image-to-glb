#!/usr/bin/env bash
# Install the Kiln engine and create a Claude Code authoring workspace.
# Usage: scripts/setup.sh [workspace-dir]   (default: ./kiln-workspace)
set -euo pipefail
WS="${1:-kiln-workspace}"
mkdir -p "$WS"; WS="$(cd "$WS" && pwd)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${KILN_ENGINE_DIR:-$HOME/kiln-install}"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(!(a===22&&b>=2||a>22||a===20&&b>=15)){console.error("Kiln needs Node 20.15+ or 22.2+");process.exit(1)}'

mkdir -p "$ENGINE"
(cd "$ENGINE" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install @instruktlabs/kiln)
(cd "$ENGINE" && npx --offline --no -- kiln-init "$WS" --harness claude)

mkdir -p "$WS/.claude/skills"
cp -r "$HERE/.claude/skills/kiln-text-image-to-glb" "$WS/.claude/skills/"
echo "Done. cd $WS && claude   (accept the project and MCP trust prompts)"
