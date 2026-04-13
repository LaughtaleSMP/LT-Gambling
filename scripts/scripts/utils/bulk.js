import { world } from "@minecraft/server";
import { CFG, PT_POOL, PT_TAG_SET, EXPORT_VER } from "../config.js";
import { dpGet, getPlayerReg, setPlayerReg } from "./storage.js";
import { getGem, getGemFromScoreboard } from "./scoreboard.js";
import { ptToBitmask, bitmaskToPt, playerPtMask, batchSyncToRegistry } from "./player.js";
import { applyImport, applyImportOfflineBatch } from "./export.js";

// Helper: apakah entry ini punya data yang berarti (gem > 0 atau punya partikel)
const hasData = e => e.gem > 0 || (e.ptmask && e.ptmask !== "0");

export function buildBulkExport() {
  const onlinePlrs = world.getPlayers();
  batchSyncToRegistry(onlinePlrs);
  const reg = getPlayerReg();
  const onlineMap = new Map(onlinePlrs.map(p => [p.id, p]));
  const all = [];

  for (const player of onlinePlrs) {
    const pity   = dpGet(CFG.K_EQ_PITY + player.id, { sr:0, l:0 });
    const ptmask = playerPtMask(player);
    const gem    = getGem(player);
    all.push({ id: player.id, name: player.name, gem, ptmask, eqsr: pity.sr, eql: pity.l, isOnline: true });
  }
  for (const [id, info] of Object.entries(reg)) {
    if (onlineMap.has(id)) continue;
    const sb   = getGemFromScoreboard(info.name);
    const mask = info.ptm !== undefined
      ? info.ptm
      : ptToBitmask(dpGet(CFG.K_PT_DATA + id, []).filter(t => PT_TAG_SET.has(t)));
    const pity = dpGet(CFG.K_EQ_PITY + id, { sr:0, l:0 });
    const gem  = sb > 0 ? sb : (info.gem ?? 0);
    all.push({ id, name: info.name, gem, ptmask: mask, eqsr: pity.sr, eql: pity.l, isOnline: false });
  }

  // Hanya simpan player yang punya gem > 0 atau punya partikel
  const entries = all
    .filter(hasData)
    .sort((a, b) => { if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1; return a.name.localeCompare(b.name); });

  const parts = [CFG.EXPORT_VER_BULK, String(entries.length), ...entries.map(e => `${e.name}:${e.gem}:${e.ptmask}:${e.eqsr}:${e.eql}`)];
  return { entries, full: parts.join("|") };
}

// Hanya log satu baris string ke console, tanpa daftar nama player
export function logBulkToConsole({ entries, full }) {
  console.log(`[GachaExport] ${entries.length} player | ${full.length} chars`);
  console.log(`[GachaExport] ${full}`);
}

export function parseBulkImport(str) {
  try {
    const parts = str.trim().split("|");
    if (parts[0] !== CFG.EXPORT_VER_BULK)
      return { ok:false, err:`Versi tidak cocok. Butuh "${CFG.EXPORT_VER_BULK}", dapat "${parts[0]}".` };
    const items = [];
    for (let i = 2; i < parts.length; i++) {
      const segs = parts[i].split(":");
      if (segs.length < 5) continue;
      const [name, gemStr, ptmask, eqsrStr, eqlStr] = segs;
      if (!name) continue;
      items.push({
        name,
        gem:       Math.max(0, parseInt(gemStr)  || 0),
        particles: bitmaskToPt(ptmask),
        eqsr:      Math.max(0, parseInt(eqsrStr) || 0),
        eql:       Math.max(0, parseInt(eqlStr)  || 0),
      });
    }
    if (!items.length) return { ok:false, err:"Tidak ada data player ditemukan dalam string." };
    return { ok:true, count: parseInt(parts[1]) || items.length, items };
  } catch (e) { return { ok:false, err:String(e) }; }
}

export function applyBulkAll(items) {
  const onlineMap = new Map(world.getPlayers().map(p => [p.name.toLowerCase(), p]));
  const reg = getPlayerReg();
  const nameToId = Object.fromEntries(Object.entries(reg).map(([id, info]) => [info.name.toLowerCase(), id]));
  let applied = 0, notFound = 0;
  const notFoundNames = [];
  const offlineBatch = [];

  for (const entry of items) {
    const key = entry.name.toLowerCase(), online = onlineMap.get(key);
    if (online) {
      applyImport(online, entry); applied++;
      online.sendMessage(`§a[★] Data diperbarui admin (bulk import).\n§7Gem: §b${entry.gem}§7  Partikel: §e${entry.particles.length}`);
    } else {
      const pid = nameToId[key];
      if (pid) offlineBatch.push({ playerId: pid, data: entry });
      else { notFound++; notFoundNames.push(entry.name); console.warn(`[GachaBulk] Player tidak ditemukan: ${entry.name}`); }
    }
  }

  const regDirty = applyImportOfflineBatch(offlineBatch, reg);
  if (regDirty) setPlayerReg(reg);

  return { applied, pending: offlineBatch.length, notFound, notFoundNames };
}

export const bulkEntryToIndividual = entry =>
  `${EXPORT_VER}|gem:${entry.gem}|pt:${bitmaskToPt(entry.ptmask).join(",")}|eqsr:${entry.eqsr}|eql:${entry.eql}`;