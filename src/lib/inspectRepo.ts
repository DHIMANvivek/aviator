import fs from "node:fs";
import path from "node:path";

// Looks inside a repo so the project dialog can suggest frontend/backend folders and the
// checks to run for them, instead of making you type paths and commands.

export type RepoCandidate = {
  /** Relative to the repo root, forward slashes. */
  path: string;
  kind: "frontend" | "backend" | "shared";
  framework?: string;
  /** Test/lint/typecheck commands from the folder's own package.json scripts. */
  checks: string[];
};

export type RepoInspection = {
  candidates: RepoCandidate[];
  /** Checks for the repo root itself (used for separate frontend/backend repos). */
  rootChecks: string[];
  /** Folders you passed in that don't exist in this repo. */
  missing: string[];
};

const CONTAINERS = ["apps", "packages", "services", "libs", "modules", "projects", "frontend", "backend"];
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "composer.json", "Gemfile"];
const SKIP = new Set(["node_modules", "dist", "build", "coverage", "out", "target", "vendor", "patches", "tmp"]);

const BACKEND_DEPS: [string, string][] = [
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["hono", "Hono"],
  ["@hapi/hapi", "hapi"],
];
const FRONTEND_DEPS: [string, string][] = [
  ["next", "Next.js"],
  ["expo", "Expo"],
  ["react-native", "React Native"],
  ["nuxt", "Nuxt"],
  ["@angular/core", "Angular"],
  ["svelte", "Svelte"],
  ["vue", "Vue"],
  ["vite", "Vite"],
  ["react", "React"],
];
const BACKEND_NAME = /(^|[-_.])(api|server|backend|service|services|worker|gateway)($|[-_.])/i;
const FRONTEND_NAME = /(web|app|client|frontend|portal|admin|site|ui|dashboard|mobile)/i;
const CHECK_SCRIPTS = ["test", "lint", "typecheck", "type-check", "check-types", "tsc"];

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function runner(root: string): (dir: string, script: string) => string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
    return (dir, s) => `pnpm --dir ${dir} run ${s}`;
  }
  if (fs.existsSync(path.join(root, "yarn.lock"))) return (dir, s) => `yarn --cwd ${dir} ${s}`;
  return (dir, s) => (s === "test" ? `npm --prefix ${dir} test` : `npm --prefix ${dir} run ${s}`);
}

function describe(root: string, rel: string, run: (dir: string, s: string) => string): RepoCandidate | null {
  const abs = path.join(root, rel);
  const hasManifest = MANIFESTS.some((m) => fs.existsSync(path.join(abs, m)));
  const name = path.basename(rel);
  const pkg = readJson(path.join(abs, "package.json"));
  const deps = { ...((pkg?.dependencies as object) ?? {}), ...((pkg?.devDependencies as object) ?? {}) } as Record<string, string>;
  const backend = BACKEND_DEPS.find(([d]) => deps[d]);
  const frontend = FRONTEND_DEPS.find(([d]) => deps[d]);
  // Server frameworks win: an API package can still list react for emails or shared types.
  const kind: RepoCandidate["kind"] = backend
    ? "backend"
    : frontend
      ? "frontend"
      : BACKEND_NAME.test(name)
        ? "backend"
        : FRONTEND_NAME.test(name) && !/^(ui|shared|common|types|config)/i.test(name)
          ? "frontend"
          : "shared";
  if (!hasManifest && kind === "shared") return null;
  const scripts = Object.keys((pkg?.scripts as object) ?? {});
  return {
    path: rel,
    kind,
    framework: (backend ?? frontend)?.[1],
    checks: CHECK_SCRIPTS.filter((s) => scripts.includes(s)).map((s) => run(rel, s)),
  };
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function inspectRepo(root: string, dirs: string[] = []): RepoInspection {
  const run = runner(root);
  const rels = new Set<string>();
  for (const top of subdirs(root)) {
    if (CONTAINERS.includes(top)) for (const child of subdirs(path.join(root, top))) rels.add(`${top}/${child}`);
    else rels.add(top);
  }
  const candidates = [...rels]
    .map((rel) => describe(root, rel, run))
    .filter((c): c is RepoCandidate => !!c)
    .sort((a, b) => a.path.localeCompare(b.path));

  const rootPkg = readJson(path.join(root, "package.json"));
  const rootScripts = Object.keys((rootPkg?.scripts as object) ?? {});
  const rootChecks = CHECK_SCRIPTS.filter((s) => rootScripts.includes(s)).map((s) =>
    s === "test" ? "npm test" : `npm run ${s}`,
  );

  return {
    candidates,
    rootChecks,
    missing: dirs.filter((d) => !fs.existsSync(path.resolve(root, d))),
  };
}
