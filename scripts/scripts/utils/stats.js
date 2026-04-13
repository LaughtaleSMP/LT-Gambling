import { CFG, R, R_KEYS, R_INIT } from "../config.js";
import { dpGet, dpSet } from "./storage.js";

const DEF_STATS = () => ({ total: 0, by: Object.fromEntries(R_KEYS.map(k => [k, 0])), last: [] });

export function getStats(key, p) {
  const r = dpGet(key + p.id, null);
  if (!r) return DEF_STATS();
  return { total: r.total ?? 0, by: r.by ?? DEF_STATS().by, last: Array.isArray(r.last) ? r.last : [] };
}

export function recordStats(key, p, items) {
  const s = getStats(key, p);
  for (const item of items) {
    s.total++;
    s.by[item.rarity] = (s.by[item.rarity] ?? 0) + 1;
    s.last.unshift(`${item.rarity[0]}:${item.name}${item.isDup ? "*" : ""}`);
  }
  s.last = s.last.slice(0, 10);
  dpSet(key + p.id, s);
}

export function pushPlayerHist(p, items, type) {
  const hist = dpGet(CFG.K_HIST + p.id, []);
  for (const item of items)
    hist.unshift({ t: type === "PARTICLE" ? "PT" : "EQ", r: item.rarity, n: item.name, d: !!item.isDup });
  dpSet(CFG.K_HIST + p.id, hist.slice(0, 10));
}

export function pushGlobalHist(playerName, items, type) {
  const isPt = type === "PARTICLE";
  const toRecord = items.filter(i => !i.isDup && (isPt || R_KEYS.indexOf(i.rarity) >= 2));
  if (!toRecord.length) return;
  const hist = dpGet(CFG.K_GLOBAL_HIST, []);
  for (const item of toRecord)
    hist.unshift({ p: playerName, t: isPt ? "PT" : "EQ", r: item.rarity, n: item.name });
  dpSet(CFG.K_GLOBAL_HIST, hist.slice(0, 30));
}

export const fmtShort = e => {
  const ci = e.indexOf(":"), init = e.slice(0, ci), rest = e.slice(ci + 1), dup = rest.endsWith("*");
  return `${R[R_INIT[init] ?? "COMMON"].color}[${init}] §f${dup ? rest.slice(0, -1) : rest}${dup ? " §7(D)" : ""}`;
};
