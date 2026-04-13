import { world } from "@minecraft/server";
import { CFG, PT_POOL, PT_TAG_SET, EXPORT_VER } from "../config.js";
import { dpGet, dpSet, dpDel, getPlayerReg, setPlayerReg } from "./storage.js";
import { getGem, setGem, getGemFromScoreboard } from "./scoreboard.js";
import { ptToBitmask, bitmaskToPt, syncPlayerData, syncPlayerDataForce, batchSyncToRegistry } from "./player.js";

export function buildExportString(player) {
  const eq   = dpGet(CFG.K_EQ_PITY + player.id, { sr:0, l:0 });
  const tags = PT_POOL.filter(p => player.hasTag(p.tag)).map(p => p.tag).join(",");
  return `${EXPORT_VER}|gem:${getGem(player)}|pt:${tags}|eqsr:${eq.sr}|eql:${eq.l}`;
}

export function buildExportStringById(playerId) {
  const reg = getPlayerReg(), info = reg[playerId];
  if (!info) return null;
  const sb  = getGemFromScoreboard(info.name);
  const gem = sb > 0 ? sb : (info.gem ?? 0);
  const tags = info.ptm !== undefined
    ? bitmaskToPt(info.ptm).filter(t => PT_TAG_SET.has(t)).join(",")
    : dpGet(CFG.K_PT_DATA + playerId, []).filter(t => PT_TAG_SET.has(t)).join(",");
  const eq = dpGet(CFG.K_EQ_PITY + playerId, { sr:0, l:0 });
  return { name: info.name, str: `${EXPORT_VER}|gem:${gem}|pt:${tags}|eqsr:${eq.sr}|eql:${eq.l}` };
}

// [FIX M-3] Batch registry update: satu read + satu write untuk semua online player
export function buildExportAll() {
  const onlinePlrs = world.getPlayers();
  // Sync semua online player ke registry dalam satu operasi tulis
  batchSyncToRegistry(onlinePlrs);
  const reg = getPlayerReg();
  const onlineIds = new Set(onlinePlrs.map(p => p.id));
  const results = [];
  for (const player of onlinePlrs)
    results.push({ id: player.id, name: player.name, str: buildExportString(player), isOnline: true });
  for (const [id, info] of Object.entries(reg)) {
    if (onlineIds.has(id)) continue;
    const exp = buildExportStringById(id);
    if (exp) results.push({ id, name: exp.name, str: exp.str, isOnline: false });
  }
  return results.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function logExportToConsole(entries) {
  const sep = "=".repeat(60);
  console.log(`[GachaExport] ${sep}\n[GachaExport] EXPORT ALL | ${entries.length} player\n[GachaExport] ${sep}`);
  for (const e of entries)
    console.log(`[GachaExport] [${e.isOnline ? "ONLINE " : "OFFLINE"}] ${e.name}\n[GachaExport]   ${e.str}`);
  console.log(`[GachaExport] ${sep}`);
}

export function parseImportString(str) {
  try {
    const parts = str.trim().split("|");
    if (parts[0] !== EXPORT_VER) return { ok:false, err:"Versi tidak cocok (butuh GS5)." };
    let gem = 0, particles = [], eqsr = 0, eql = 0;
    for (const part of parts.slice(1)) {
      const ci = part.indexOf(":");
      if (ci < 0) continue;
      const key = part.slice(0, ci), val = part.slice(ci + 1);
      if (key === "gem")  gem       = Math.max(0, parseInt(val) || 0);
      if (key === "pt")   particles = val ? val.split(",").filter(t => PT_TAG_SET.has(t)) : [];
      if (key === "eqsr") eqsr      = Math.max(0, parseInt(val) || 0);
      if (key === "eql")  eql       = Math.max(0, parseInt(val) || 0);
    }
    return { ok:true, gem, particles, eqsr, eql };
  } catch (e) { return { ok:false, err:String(e) }; }
}

export function applyImport(target, data) {
  setGem(target, data.gem);
  for (const pt of PT_POOL) { try { target.removeTag(pt.tag); } catch {} }
  for (const tag of data.particles) { try { target.addTag(tag); } catch {} }
  dpSet(CFG.K_EQ_PITY + target.id, {
    sr: Math.min(data.eqsr, CFG.EQ_PITY_RARE),
    l:  Math.min(data.eql,  CFG.EQ_PITY_LEG),
  });
  syncPlayerDataForce(target);
}

export function applyImportOffline(playerId, data) {
  dpSet(CFG.K_IMPORT_PEND + playerId, { gem: data.gem, particles: data.particles, eqsr: data.eqsr, eql: data.eql });
  dpSet(CFG.K_EQ_PITY + playerId, { sr: Math.min(data.eqsr, CFG.EQ_PITY_RARE), l: Math.min(data.eql, CFG.EQ_PITY_LEG) });
  dpSet(CFG.K_PT_DATA + playerId, data.particles.filter(t => PT_TAG_SET.has(t)));
}

// Versi batch: update registry sekaligus untuk banyak player offline
// Dipakai oleh applyBulkAll — jangan panggil applyImportOffline dalam loop!
export function applyImportOfflineBatch(entries, reg) {
  let dirty = false;
  for (const { playerId, data } of entries) {
    dpSet(CFG.K_IMPORT_PEND + playerId, { gem: data.gem, particles: data.particles, eqsr: data.eqsr, eql: data.eql });
    dpSet(CFG.K_EQ_PITY + playerId, { sr: Math.min(data.eqsr, CFG.EQ_PITY_RARE), l: Math.min(data.eql, CFG.EQ_PITY_LEG) });
    dpSet(CFG.K_PT_DATA + playerId, data.particles.filter(t => PT_TAG_SET.has(t)));
    if (reg[playerId]) {
      reg[playerId].gem = data.gem;
      reg[playerId].ptm = ptToBitmask(data.particles.filter(t => PT_TAG_SET.has(t)));
      dirty = true;
    }
  }
  return dirty;
}

export function applyPendingImport(player) {
  const pending = dpGet(CFG.K_IMPORT_PEND + player.id, null);
  if (!pending) return false;
  applyImport(player, pending);
  dpDel(CFG.K_IMPORT_PEND + player.id);
  return pending;
}
