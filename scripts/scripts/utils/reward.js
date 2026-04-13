import { ItemStack, EnchantmentTypes } from "@minecraft/server";
import { CFG, PT_POOL, EQ_POOL, EQ_IDX } from "../config.js";
import { dpGet, dpSet } from "./storage.js";
import { refundGem } from "./scoreboard.js";
import { syncPlayerData } from "./player.js";

export function applyEnchants(stack, rarity, id) {
  if (rarity !== "EPIC" && rarity !== "LEGENDARY") return;
  try {
    const enc = stack.getComponent("minecraft:enchantable"); if (!enc) return;
    const add = (e, l) => { try { enc.addEnchantment({ type: EnchantmentTypes.get(e), level: l }); } catch {} };
    const sw   = id.includes("sword");
    const helm = id.includes("helmet"), chst = id.includes("chestplate"), legs = id.includes("leggings");
    if (rarity === "EPIC") {
      if (sw)                    { add("sharpness",3); add("fire_aspect",1); add("unbreaking",2); }
      else if (helm||chst||legs) { add("protection",3); add("unbreaking",2); }
      else if (id === "minecraft:bow")      { add("power",3); add("punch",1); }
      else if (id === "minecraft:crossbow") { add("multishot",1); add("unbreaking",2); }
    } else {
      if (sw)                    { add("sharpness",5); add("fire_aspect",2); add("looting",3); add("unbreaking",3); }
      else if (helm||chst||legs) {
        add("protection",4); add("unbreaking",3);
        if (chst) add("thorns",3); if (helm) add("aqua_affinity",1);
      }
      else if (id === "minecraft:bow")      { add("power",5); add("punch",2); add("infinity",1); }
      else if (id === "minecraft:crossbow") { add("multishot",1); add("quick_charge",3); add("unbreaking",3); }
    }
  } catch {}
}

const encPend = list => list.map(it => ({ i: EQ_IDX.get(it.id) ?? -1 })).filter(e => e.i !== -1);
const decPend = raw  => raw.filter(e => e.i >= 0 && e.i < EQ_POOL.length).map(({ i }) => ({ ...EQ_POOL[i] }));

export const getPend = p => decPend(dpGet(CFG.K_EQ_PEND + p.id, []));

export function savePend(p, list) {
  let enc = encPend(list), str = JSON.stringify(enc);
  const orig = enc.length;
  while (enc.length > 0 && str.length > 30000) { enc.pop(); str = JSON.stringify(enc); }
  if (enc.length < orig) console.warn(`[Gacha] savePend: ${orig - enc.length} item terpotong (${p.name})`);
  dpSet(CFG.K_EQ_PEND + p.id, enc);
}

export function addPend(p, item) {
  const list = getPend(p);
  if (list.length >= CFG.MAX_PENDING) { p.sendMessage("§c[!] Pending penuh! Klaim dulu."); return false; }
  list.push(item); savePend(p, list); return true;
}

export function claimPend(p) {
  const list = getPend(p); if (!list.length) return 0;
  const inv = p.getComponent("minecraft:inventory")?.container; if (!inv) return 0;
  const still = []; let n = 0;
  for (const item of list) {
    const stack = new ItemStack(item.id, item.qty ?? 1);
    applyEnchants(stack, item.rarity, item.id);
    if (inv.addItem(stack)) still.push(item); else n++;
  }
  savePend(p, still); return n;
}

export function applyReward(player, item, type) {
  if (type === "PARTICLE") {
    if (player.hasTag(item.tag)) { refundGem(player, CFG.GEM_REFUND); return { ...item, isDup: true }; }
    player.addTag(item.tag);
    syncPlayerData(player);
    return { ...item, isDup: false };
  }
  const stack = new ItemStack(item.id, item.qty ?? 1);
  applyEnchants(stack, item.rarity, item.id);
  const inv = player.getComponent("minecraft:inventory")?.container;
  if (inv) { if (inv.addItem(stack)) addPend(player, item); }
  else addPend(player, item);
  return { ...item, isDup: false };
}

export function preCheckDupBatch(player, items, type) {
  if (type !== "PARTICLE") return items.map(r => ({ ...r, isDup: false }));
  const seen = new Set();
  return items.map(r => {
    const isDup = player.hasTag(r.tag) || seen.has(r.tag);
    if (!isDup) seen.add(r.tag);
    return { ...r, isDup };
  });
}
