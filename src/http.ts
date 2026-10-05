// Fetch with a timeout, one retry, and a small cache (memory + disk) so repeat
// questions in a session don't re-download the same table.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = process.env.AUSSIE_DATA_CACHE_DIR || join(tmpdir(), "aussie-data-mcp");
const TTL_MS = Number(process.env.AUSSIE_DATA_CACHE_TTL_HOURS || 6) * 3600_000;
const mem = new Map<string, { at: number; body: string }>();

export class UpstreamError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
  }
}

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const key = createHash("sha1").update(url + JSON.stringify(headers)).digest("hex");
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;

  const file = join(CACHE_DIR, key);
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < TTL_MS) {
      const body = await readFile(file, "utf8");
      mem.set(key, { at: s.mtimeMs, body });
      return body;
    }
  } catch { /* no cache yet */ }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "aussie-data-mcp (+https://github.com/dylannnnn111/aussie-data-mcp)", ...headers },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (!res.ok) throw new UpstreamError(`${res.status} from ${new URL(url).host}`, res.status, body.slice(0, 500));
      mem.set(key, { at: Date.now(), body });
      mkdir(CACHE_DIR, { recursive: true }).then(() => writeFile(file, body)).catch(() => {});
      return body;
    } catch (e) {
      lastErr = e;
      // Don't retry a clean "no data" answer
      if (e instanceof UpstreamError && e.status && e.status < 500) throw e;
    }
  }
  throw lastErr;
}
