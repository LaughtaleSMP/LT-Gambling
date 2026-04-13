import { system } from "@minecraft/server";
import { CFG, PT_POOL, PT_TAG_SET } from "../config.js";
import { dpGet, dpSet, getPlayerReg, setPlayerReg } from "./storage.js";
import { getGem, getCoin } from "./scoreboard.js";

function b36toBigInt(str) {
  let result = 0n;
  for (const c of (str || "0").toLowerCase()) {
    const d = c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 87;
    result = result * 36n + BigInt(d);
  }
  return result;
}

export const ptToBitmask = tags => {
  let m = 0n;
  PT_POOL.forEach((p, i) => { if (tags.includes(p.tag)) m |= (1n << BigInt(i)); });
  return m.toString(36);
};

// [FIX BUG-8] Tambahkan filter PT_TAG_SET.has(p.tag) agar tag yang sudah tidak ada
// di PT_POOL (misal item dihapus dari pool di versi baru) tidak di-addTag ke player.
// Sebelumnya hanya filter by index sehingga jika PT_POOL berubah, tag stale bisa lolos.
export const bitmaskToPt = str => {
  try {
    if (!str || str === "0") return [];
    const m = b36toBigInt(str);
    return PT_POOL
      .filter((p, i) => ((m >> BigInt(i)) & 1n) && PT_TAG_SET.has(p.tag))
      .map(p => p.tag);
  } catch { return []; }
};

export const playerPtMask = player =>
  ptToBitmask(PT_POOL.filter(p => player.hasTag(p.tag)).map(p => p.tag));

const _syncCooldown = new Map();

export function syncPlayerData(player) {
  try {
    const now = system.currentTick;
    if ((now - (_syncCooldown.get(player.id) ?? -999)) < 20) return;
    _syncCooldown.set(player.id, now);
    const reg = getPlayerReg();
    const ptTags = PT_POOL.filter(p => player.hasTag(p.tag)).map(p => p.tag);
    reg[player.id] = { name: player.name, gem: getGem(player), coin: getCoin(player), ptm: ptToBitmask(ptTags) };
    setPlayerReg(reg);
    dpSet(CFG.K_PT_DATA + player.id, ptTags);
  } catch (e) { console.warn("[Gacha] syncPlayerData:", e); }
}

export function syncPlayerDataForce(player) {
  _syncCooldown.delete(player.id);
  syncPlayerData(player);
}

export function batchSyncToRegistry(players) {
  try {
    const reg = getPlayerReg();
    for (const player of players) {
      const ptTags = PT_POOL.filter(p => player.hasTag(p.tag)).map(p => p.tag);
      reg[player.id] = { name: player.name, gem: getGem(player), coin: getCoin(player), ptm: ptToBitmask(ptTags) };
      dpSet(CFG.K_PT_DATA + player.id, ptTags);
      _syncCooldown.set(player.id, system.currentTick);
    }
    if (players.length) setPlayerReg(reg);
    return reg;
  } catch (e) { console.warn("[Gacha] batchSyncToRegistry:", e); return null; }
}