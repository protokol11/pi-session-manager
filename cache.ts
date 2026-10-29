// Safe JSON cache I/O shared by the extension's sidecar/index files.
// Concurrent writers to one path are serialized in-process: a single write is
// in flight per path, later calls coalesce to the latest value, and each write
// lands via a unique temp file + atomic rename. No pi imports.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Waiter = { resolve: () => void; reject: (err: unknown) => void };

type Slot = {
  running: boolean;
  pending: boolean;
  value: unknown;
  waiters: Waiter[];
};

const slots = new Map<string, Slot>();
let tmpCounter = 0;

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function pump(file: string, slot: Slot): Promise<void> {
  try {
    while (slot.pending) {
      slot.pending = false;
      const value = slot.value;
      const waiters = slot.waiters;
      slot.waiters = [];
      try {
        await atomicWrite(file, value);
      } catch (err) {
        // Reject this batch before rethrowing so its waiters never hang; the
        // outer catch rejects any newer waiters queued during the failed write.
        for (const w of waiters) w.reject(err);
        throw err;
      }
      for (const w of waiters) w.resolve();
    }
  } catch (err) {
    for (const w of slot.waiters) w.reject(err);
    slot.waiters = [];
    slot.pending = false;
  } finally {
    slot.running = false;
    if (slot.pending) {
      void pump(file, slot);
    } else if (slot.waiters.length === 0) {
      slots.delete(file);
    }
  }
}

/**
 * Serialize writes to one path. A single write is in flight per path; calls
 * made while one is in flight coalesce to the latest value, and one follow-up
 * write runs afterward. Each write uses a unique temp file + atomic rename,
 * so a crash cannot leave a half-written file in place.
 */
export function writeJsonSafe(file: string, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let slot = slots.get(file);
    if (!slot) {
      slot = { running: false, pending: false, value: undefined, waiters: [] };
      slots.set(file, slot);
    }
    slot.value = value;
    slot.pending = true;
    slot.waiters.push({ resolve, reject });
    if (!slot.running) {
      slot.running = true;
      void pump(file, slot);
    }
  });
}

/** Read + parse JSON. A missing or malformed file returns undefined. */
export async function readJsonSafe(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
