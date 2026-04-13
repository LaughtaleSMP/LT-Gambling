import { system } from "@minecraft/server";
import { lockSet } from "../config.js";

export const sfx = (player, s, overridePitch) => {
  try { player.playSound(s.id, { pitch: overridePitch ?? s.pitch, volume: s.vol }); }
  catch (e) { if (!String(e).toLowerCase().includes("player")) console.warn("[Gacha] sfx:", e); }
};

export const wait = n => new Promise(r => system.runTimeout(r, n));

// [FIX BUG-1] withLock sebelumnya mengembalikan { locked: false } saat terkunci.
// Objek selalu truthy, sehingga if (!paid) tidak pernah mendeteksi kondisi terkunci.
// Sekarang mengembalikan false (falsy) agar semua caller if (!result) bekerja benar.
export async function withLock(id, fn) {
  if (lockSet.has(id)) return false;
  lockSet.add(id);
  try { return await fn(); }
  finally { lockSet.delete(id); }
}

export const freeSlots = p => {
  const inv = p.getComponent("minecraft:inventory")?.container;
  if (!inv) return 0;
  let f = 0;
  for (let i = 0; i < inv.size; i++) if (!inv.getItem(i)) f++;
  return f;
};

export const tGet = (p, pfx, def) => {
  try {
    const t = p.getTags().find(x => x.startsWith(pfx));
    if (!t) return def;
    const val = parseInt(t.slice(pfx.length));
    return Number.isFinite(val) ? val : def;
  } catch { return def; }
};

export const tSet = (p, pfx, v) => {
  try {
    const old = p.getTags().find(x => x.startsWith(pfx));
    if (old) p.removeTag(old);
    p.addTag(pfx + v);
  } catch {}
};