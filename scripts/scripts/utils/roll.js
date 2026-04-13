import { CFG, T, R_KEYS, PT_WP, PT_RARE, EQ_WP, EQ_RARE, EQ_LEG, rand, randW } from "../config.js";
import { tGet, tSet } from "./core.js";
import { dpGet, dpSet } from "./storage.js";

export function rollPt(player) {
  const sr = tGet(player, T.PTPY, 0) + 1;
  const result = sr >= CFG.PT_PITY_RARE ? rand(PT_RARE) : randW(PT_WP);
  tSet(player, T.PTPY, R_KEYS.indexOf(result.rarity) >= 2 ? 0 : sr);
  return result;
}

export function rollEq(player) {
  const p = dpGet(CFG.K_EQ_PITY + player.id, { sr:0, l:0 });
  p.sr++; p.l++;
  const result =
    p.l  >= CFG.EQ_PITY_LEG  ? rand(EQ_LEG)  :
    p.sr >= CFG.EQ_PITY_RARE ? rand(EQ_RARE) :
    randW(EQ_WP);
  if (result.rarity === "LEGENDARY")           { p.sr = 0; p.l = 0; }
  else if (R_KEYS.indexOf(result.rarity) >= 2) { p.sr = 0; }
  dpSet(CFG.K_EQ_PITY + player.id, p);
  return result;
}

export function rollMany(rollFn, player, n) {
  const arr = Array.from({ length: n }, () => rollFn(player));
  let bi = 0;
  for (let i = 1; i < n; i++)
    if (R_KEYS.indexOf(arr[i].rarity) > R_KEYS.indexOf(arr[bi].rarity)) bi = i;
  const tmp = arr[bi]; arr[bi] = arr[n - 1]; arr[n - 1] = tmp;
  return arr;
}
