import { world } from "@minecraft/server";
import { CFG } from "../config.js";

const MAX_CHUNK_SCAN = 32;
// [FIX BUG-7] Batas aman sebelum dpSet peringatkan admin.
// Minecraft membatasi ~32KB per dynamic property. Di atas 30KB kita log warning.
const DP_SIZE_WARN = 30000;

export function dpSetChunked(baseKey, value) {
  try {
    const str = JSON.stringify(value), sz = CFG.CHUNK_SZ;
    const n = Math.max(1, Math.ceil(str.length / sz));
    const oldN = world.getDynamicProperty(baseKey + "_cn") ?? 0;
    for (let i = n; i < Math.min(oldN, n + MAX_CHUNK_SCAN); i++) {
      try { world.setDynamicProperty(baseKey + "_c" + i, undefined); } catch {}
    }
    world.setDynamicProperty(baseKey + "_cn", n);
    for (let i = 0; i < n; i++)
      world.setDynamicProperty(baseKey + "_c" + i, str.slice(i * sz, (i + 1) * sz));
  } catch (e) { console.error("[Gacha] dpSetChunked:", baseKey, e); }
}

export function dpGetChunked(baseKey, def) {
  try {
    const n = world.getDynamicProperty(baseKey + "_cn");
    if (n && n > 0) {
      let str = "";
      for (let i = 0; i < n; i++) str += (world.getDynamicProperty(baseKey + "_c" + i) ?? "");
      return JSON.parse(str) ?? def;
    }
    const raw = world.getDynamicProperty(baseKey);
    if (raw !== undefined && raw !== null) return JSON.parse(raw) ?? def;
    return def;
  } catch { return def; }
}

export function dpDelChunked(baseKey) {
  try {
    const n = world.getDynamicProperty(baseKey + "_cn") ?? 0;
    world.setDynamicProperty(baseKey + "_cn", undefined);
    for (let i = 0; i < n + MAX_CHUNK_SCAN; i++)
      try { world.setDynamicProperty(baseKey + "_c" + i, undefined); } catch {}
    try { world.setDynamicProperty(baseKey, undefined); } catch {}
  } catch {}
}

export const dpGet = (k, def) => {
  try { return JSON.parse(world.getDynamicProperty(k) ?? "null") ?? def; } catch { return def; }
};

// [FIX BUG-7] Tambahkan peringatan jika data mendekati batas Minecraft (32KB).
// Ini mencegah silent write failure yang membuat data hilang tanpa pesan error.
export const dpSet = (k, v) => {
  try {
    const str = JSON.stringify(v);
    if (str.length > DP_SIZE_WARN) {
      console.warn(`[Gacha] dpSet WARNING: "${k}" ukuran ${str.length} chars melebihi batas aman! Gunakan dpSetChunked untuk data besar.`);
    }
    world.setDynamicProperty(k, str);
  } catch (e) { console.error("[Gacha] dpSet gagal untuk key:", k, e); }
};

export const dpDel = k => { try { world.setDynamicProperty(k, undefined); } catch {} };

export const getPlayerReg = () => dpGetChunked(CFG.K_PLAYER_REG, {});
export const setPlayerReg = reg => dpSetChunked(CFG.K_PLAYER_REG, reg);