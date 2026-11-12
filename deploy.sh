#!/usr/bin/env bash
set -euo pipefail

# deploy.sh for @goodandready/dsh-kanban — canonical deployment and verification script.
#
# Usage:
#   ./deploy.sh             # pre-deploy checks (tests, audit, pack size, identity)
#   ./deploy.sh --install   # install published package into $DSH_PROFILE and restart service

PROFILE="${DSH_PROFILE:-web}"
PACKAGE="@goodandready/dsh-kanban"

echo "== dsh-kanban deploy checks (profile: ${PROFILE}) =="

echo "-- Test suite"
npm test

echo "-- Dependency audit"
npm audit --omit=dev

echo "-- Package identity check (name must match in four places)"
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const patch = fs.readFileSync("cordis.patch.yml", "utf8");
const client = fs.readFileSync("lib/client.js", "utf8");
const server = fs.readFileSync("lib/index.js", "utf8");
const name = "@goodandready/dsh-kanban";
const q = String.fromCharCode(39);
if (pkg.name !== name) { console.error("IDENTITY MISMATCH in package.json"); process.exit(1); }
if (!patch.includes(name)) { console.error("IDENTITY MISMATCH in cordis.patch.yml"); process.exit(1); }
if (!client.includes(name) || !client.includes("id: " + q + name + q)) {
  console.error("IDENTITY MISMATCH in lib/client.js"); process.exit(1);
}
if (!server.includes(name) || !server.includes("export const name = " + q + name + q)) {
  console.error("IDENTITY MISMATCH in lib/index.js"); process.exit(1);
}
console.log("identity ok");
'

echo "-- Package composition & size check"
node --test test/pack-size.test.mjs

if [ "${1:-}" = "--install" ]; then
  echo "-- Installing published package into profile ${PROFILE}"
  pnpm --prefix "/home/vadim/.dsh/profiles/${PROFILE}" add "${PACKAGE}@$(node -p 'require("./package.json").version')"
  echo "-- Restarting dsh-web.service"
  sudo systemctl restart dsh-web.service
  echo "-- Verifying service status"
  sleep 3
  curl -fsS --max-time 10 http://127.0.0.1:3080/dsh-kanban/whoami || {
    echo "ERROR: endpoint /dsh-kanban/whoami check failed"
    exit 1
  }
  echo "Deployment to ${PROFILE} successful!"
else
  echo "All pre-deploy checks passed. To install after approval, run: $0 --install"
fi
