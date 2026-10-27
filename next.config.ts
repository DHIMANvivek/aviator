import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Agent SDK spawns its bundled Claude Code binary from its own package
  // folder, so it must stay a plain Node dependency rather than being bundled.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // Next allows one dev server per build folder; a separate one lets `npm run demo`
  // run next to `npm run dev`.
  distDir: process.env.AVIATOR_DIST_DIR || (process.env.AVIATOR_DEMO === "1" ? ".next-demo" : ".next"),
  // Pin the root so a package-lock.json higher up (e.g. in $HOME) isn't mistaken for it.
  turbopack: { root: process.cwd() },
  // Host names you open Aviator on from other devices (e.g. an ngrok domain), comma-separated.
  // The dev server blocks its own scripts on other host names; src/proxy.ts still requires
  // AVIATOR_ACCESS_TOKEN for every request from them.
  allowedDevOrigins: (process.env.AVIATOR_PUBLIC_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
};

export default nextConfig;
