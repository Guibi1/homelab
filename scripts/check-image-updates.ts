#!/usr/bin/env bun
/**
 * check-image-updates.ts — check pinned container image tags for newer
 * major.minor versions (patches are ignored).
 *
 * Usage: bun scripts/check-image-updates.ts [--fix] [path ...]   (default: apps/)
 *   --fix  rewrite pinned tags in the manifests to the latest major.minor
 * Exit code: 1 if any image has an update and --fix was not passed, 0 otherwise.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const YAML_RE = /\.(ya?ml)$/;
const IMAGE_RE = /image:\s*["']?([^\s"'#]+)/g;
const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (YAML_RE.test(entry.name)) out.push(p);
    }
    return out;
}

/** Parse "ghcr.io/11notes/pocket-id:2.8" -> { registry, repo, tag } */
function parseImage(ref: string) {
    const [name, tag = "latest"] = ref.split("@")[0].split(":");
    const parts = name.split("/");
    // registry = first component with a dot/port, or localhost; else docker.io
    const first = parts[0];
    let registry = "index.docker.io";
    if (parts.length >= 3 || first.includes(".") || first.includes(":") || first === "localhost") {
        registry = first;
        parts.shift();
    }
    let repo = parts.join("/");
    if (registry === "index.docker.io" && !repo.includes("/")) repo = `library/${repo}`;
    return { registry, repo, tag };
}

/**
 * Tags via GET /v2/<repo>/tags/list. Registries reject anonymous pulls, so the
 * token URL is discovered from the WWW-Authenticate challenge (works generically
 * for docker.io, ghcr.io, quay.io, ...).
 */
async function listTags(registry: string, repo: string): Promise<string[]> {
    const challenge = (await fetch(`https://${registry}/v2/${repo}/tags/list?n=1`)).headers.get(
        "www-authenticate",
    );
    const realm = challenge?.match(/realm="([^"]+)"/)?.[1];
    if (!realm) throw new Error(`no auth challenge from ${registry}`);

    const service = challenge!.match(/service="([^"]+)"/)?.[1] ?? registry;
    const tokenRes = await fetch(
        `${realm}?service=${encodeURIComponent(service)}&scope=repository:${repo}:pull`,
    );
    if (!tokenRes.ok) throw new Error(`token request failed for ${registry}/${repo}`);
    const tokenBody: unknown = await tokenRes.json();
    const token =
        tokenBody && typeof tokenBody === "object" && "token" in tokenBody && typeof tokenBody.token === "string"
            ? tokenBody.token
            : null;

    const res = await fetch(`https://${registry}/v2/${repo}/tags/list?n=1000`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`tags/list failed for ${registry}/${repo}: HTTP ${res.status}`);
    const body: unknown = await res.json();
    const tags = body && typeof body === "object" && "tags" in body ? body.tags : undefined;
    if (!Array.isArray(tags)) throw new Error(`unexpected tags response from ${registry}/${repo}`);
    return tags.map(String);
}

/** "v2.8" -> {2, 8}; "1.13.1" -> {1, 13} (patch ignored); junk (incl. -arm64) -> null */
function parseVersion(tag: string) {
    const m = tag.match(/^v?(\d+)\.(\d+)(?:\.\d+)?$/);
    return m ? { major: +m[1], minor: +m[2] } : null;
}

/** latest published major.minor strictly newer than the pin, or null */
function latestBump(current: { major: number; minor: number }, tags: string[]) {
    const cur = { major: current.major, minor: current.minor };
    const [latest] = tags
        .map(parseVersion)
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .filter((v) => v.major * 1000 + v.minor > cur.major * 1000 + cur.minor)
        .sort((a, b) => b.major * 1000 + b.minor - (a.major * 1000 + a.minor));
    return latest ? `${latest.major}.${latest.minor}` : null;
}

interface Result {
    ref: string;
    current: string;
    /** latest major.minor, only set when an update exists */
    bump: string | null;
    error?: string;
}

async function checkImage(ref: string): Promise<Result> {
    const { registry, repo, tag } = parseImage(ref);
    const base: Result = { ref, current: tag, bump: null };
    const cur = parseVersion(tag);
    if (!cur) return { ...base, error: "non-semver tag, skipped" };

    try {
        const tags = await listTags(registry, repo);
        const bump = latestBump(cur, tags);
        if (!bump) return base;
        // only offer a fix if the registry actually publishes the truncated tag
        return { ...base, bump: tags.includes(bump) ? bump : null };
    } catch (e) {
        return { ...base, error: String(e) };
    }
}

async function main() {
    const argv = Bun.argv.slice(2);
    const fix = argv.includes("--fix");
    const targets = argv.filter((a) => a !== "--fix");
    const dirs = targets.length ? targets.map((t) => join(process.cwd(), t)) : [join(ROOT, "apps")];
    const files = dirs.flatMap((d) => (statSync(d).isDirectory() ? walk(d) : [d]));

    // unique image refs (a ref may appear in several manifests)
    const refs = new Map<string, string[]>();
    for (const file of files) {
        for (const m of readFileSync(file, "utf8").matchAll(IMAGE_RE)) {
            const list = refs.get(m[1]) ?? [];
            list.push(file);
            refs.set(m[1], list);
        }
    }

    console.log(`scanning ${files.length} manifests, ${refs.size} unique images\n`);

    const results = await Promise.all([...refs.keys()].map(checkImage));
    results.sort((a, b) => a.ref.localeCompare(b.ref));

    let updates = 0;
    for (const r of results) {
        if (r.error) {
            console.log(`? ${r.ref} — ${r.error}`);
        } else if (r.bump) {
            updates++;
            console.log(`✗ ${r.ref} — update available: ${r.current} → ${r.bump}`);
        } else {
            console.log(`✓ ${r.ref} — up to date`);
        }
    }
    console.log(`\n${updates} image(s) with updates, ${results.length} checked`);

    if (fix && updates > 0) {
        // rewrite all refs per file in one pass
        const rewrites = new Map<string, Map<string, string>>();
        for (const r of results) {
            if (!r.bump) continue;
            for (const file of refs.get(r.ref) ?? []) {
                const map = rewrites.get(file) ?? new Map<string, string>();
                map.set(r.ref, r.ref.replace(/:[^:@]+$/, `:${r.bump}`));
                rewrites.set(file, map);
            }
        }
        for (const [file, map] of rewrites) {
            let text = readFileSync(file, "utf8");
            for (const [oldRef, newRef] of map) text = text.replaceAll(oldRef, newRef);
            writeFileSync(file, text);
            for (const [oldRef, newRef] of map)
                console.log(`fixed ${relative(ROOT, file)}: ${oldRef} → ${newRef}`);
        }
        process.exit(0); // CI decides via the git diff
    }

    if (updates > 0) process.exit(1);
}

await main();