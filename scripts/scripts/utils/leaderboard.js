import { world, system } from "@minecraft/server";
import { CFG, PT_POOL } from "../config.js";
import { dpGet, getPlayerReg } from "./storage.js";
import { getGem, getCoin } from "./scoreboard.js";
import { bitmaskToPt } from "./player.js";

let _lbRawCache = null;
let _lbCacheTick = -999;
const LB_CACHE_TTL = 60;

function buildRawMap() {
  const now = system.currentTick;
  if (_lbRawCache && (now - _lbCacheTick) < LB_CACHE_TTL) return _lbRawCache;
  const reg = getPlayerReg();
  const map = new Map();
  for (const [id, info] of Object.entries(reg)) {
    const ptStats = dpGet(CFG.K_PT_STATS + id, null), eqStats = dpGet(CFG.K_EQ_STATS + id, null);
    const ptPulls = ptStats?.total ?? 0, eqPulls = eqStats?.total ?? 0;
    // [BUG #1 FIX downstream] bitmaskToPt sekarang mengembalikan string tags,
    // sehingga .length memberi jumlah partikel yang benar.
    map.set(info.name.toLowerCase(), {
      name: info.name, gem: info.gem ?? 0, coin: info.coin ?? 0,
      ptCount: bitmaskToPt(info.ptm ?? "0").length,
      ptPulls, eqPulls, totalPulls: ptPulls + eqPulls, isOnline: false,
    });
  }
  _lbRawCache = map;
  _lbCacheTick = now;
  return map;
}

// [IMP #2 FIX] Eliminasi N dpGet per online player.
// Stats pull (K_PT_STATS / K_EQ_STATS) sudah dibaca di buildRawMap() dan
// di-cache selama LB_CACHE_TTL tick. Untuk player online, kita hanya perlu
// meng-override gem, coin, ptCount, dan isOnline — pull stats diambil dari cache.
// Ini mengurangi storage reads dari 2×(jumlah online) menjadi 0 per pemanggilan.
export function getLeaderboard(sortBy = "gem", limit = CFG.LB_LIMIT) {
  const map = new Map(buildRawMap());
  for (const player of world.getPlayers()) {
    const cached = map.get(player.name.toLowerCase());
    const ptPulls = cached?.ptPulls ?? 0, eqPulls = cached?.eqPulls ?? 0;
    map.set(player.name.toLowerCase(), {
      name: player.name, gem: getGem(player), coin: getCoin(player),
      ptCount: PT_POOL.filter(p => player.hasTag(p.tag)).length,
      ptPulls, eqPulls, totalPulls: ptPulls + eqPulls, isOnline: true,
    });
  }
  const keyMap = { coin:"coin", ptCount:"ptCount", ptPulls:"ptPulls", eqPulls:"eqPulls", totalPulls:"totalPulls" };
  const key = keyMap[sortBy] ?? "gem";
  return [...map.values()].sort((a, b) => b[key] - a[key]).slice(0, limit);
}

export const invalidateLbCache = () => { _lbCacheTick = -999; };