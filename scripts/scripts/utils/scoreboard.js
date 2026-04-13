import { world, system } from "@minecraft/server";
import { CFG, T } from "../config.js";
import { tGet, tSet } from "./core.js";

function ensureObjective(name, displayName) {
  try {
    return world.scoreboard.getObjective(name)
      ?? world.scoreboard.addObjective(name, displayName ?? name);
  } catch (e) { console.error(`[Gacha] ensureObjective gagal "${name}":`, e); return null; }
}

export const getScore = (obj, p) => {
  const o = world.scoreboard.getObjective(obj);
  if (!o) return 0;
  try { return o.getScore(p.scoreboardIdentity ?? p) ?? 0; } catch { return 0; }
};

export const setScore = (obj, p, n) => {
  const o = ensureObjective(obj);
  if (!o) return false;
  try {
    o.setScore(p.scoreboardIdentity ?? p, Math.max(0, Math.floor(n)));
    return true;
  } catch (e) { console.error("[Gacha] setScore gagal:", obj, p?.name, e); return false; }
};

export function getGemFromScoreboard(playerName) {
  try {
    const obj = world.scoreboard.getObjective(CFG.GEM_OBJ);
    if (!obj) return 0;
    for (const ident of obj.getParticipants())
      if (ident.displayName === playerName) return obj.getScore(ident) ?? 0;
  } catch {}
  return 0;
}

export const getGem    = p     => { const t = tGet(p, T.GEM, -1); return t < 0 ? getScore(CFG.GEM_OBJ, p) : t; };
export const setGem    = (p,n) => { n = Math.max(0, Math.floor(n)); tSet(p, T.GEM, n); setScore(CFG.GEM_OBJ, p, n); };
export const deductGem = (p,n) => { const v = getGem(p); if (v < n) return false; setGem(p, v - n); return true; };
export const refundGem = (p,n) => setGem(p, getGem(p) + n);

export const getCoin    = p     => getScore(CFG.COIN_OBJ, p);
export const deductCoin = (p,n) => { const v = getCoin(p); if (v < n) return false; setScore(CFG.COIN_OBJ, p, v - n); return true; };
export const refundCoin = (p,n) => setScore(CFG.COIN_OBJ, p, getCoin(p) + n);

export const deduct = (type, p, n) => type === "PARTICLE" ? deductGem(p, n) : deductCoin(p, n);
export const refund = (type, p, n) => type === "PARTICLE" ? refundGem(p, n) : refundCoin(p, n);

system.runInterval(() => {
  for (const p of world.getPlayers()) {
    const tg = tGet(p, T.GEM, -1);
    if (tg < 0) tSet(p, T.GEM, getScore(CFG.GEM_OBJ, p));
    else { const sb = getScore(CFG.GEM_OBJ, p); if (sb !== tg) setScore(CFG.GEM_OBJ, p, tg); }
  }
}, 100);
