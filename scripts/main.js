import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";

import {
  initSecurity,
  persistLock,
  clearLock,
  isSessionOwner,
  snapshotExpected,
  registerSecureChestHandler,
  registerItemDropGuard,
} from "./security.js";

import {
  CFG, T, R, R_KEYS, HR, MARK, EXPORT_VER,
  CHEST_BASE, SLOT, SFX,
  PT_POOL, EQ_POOL, PT_TOTAL_W, EQ_TOTAL_W,
  activePlayers, activeChests, chestExpected,
  lastPull, pendingDisc, chestCache,
  lastActionBar, pendingChestInteract,
  lockSet,
  ck, bar, pctStr, isMark, rand,
} from "./config.js";

import {
  sfx, wait, withLock, freeSlots,
  tGet, setScore,
  getGem, setGem, getCoin, deduct, refund,
  dpGet, dpSet, dpDel,
  getPlayerReg, setPlayerReg,
  ptToBitmask, bitmaskToPt, playerPtMask,
  dpSetChunked, dpGetChunked,
  syncPlayerData, getGemFromScoreboard,
  getDiscCodes, saveDiscCodes, hasUsedCode, validateDisc, consumeDisc, validateAndConsumeDisc,
  rollPt, rollEq, rollMany,
  getStats, recordStats, pushPlayerHist, pushGlobalHist, fmtShort,
  getPend, savePend, addPend, claimPend,
  applyEnchants, applyReward, preCheckDupBatch,
  buildExportAll,
  logExportToConsole, parseImportString,
  applyImport, applyImportOffline, applyPendingImport,
  buildBulkExport, logBulkToConsole, parseBulkImport, applyBulkAll,
  bulkEntryToIndividual, getLeaderboard,
} from "./data.js";

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const K_PEND_GEM      = "gacha:pend_gem:";
const K_PEND_COIN     = "gacha:pend_coin:";

// [FIX RESTART] Key untuk pessimistic refund — disimpan ke DP sebelum session
// gacha dimulai, dihapus di finally setelah selesai normal. Jika server restart
// di tengah pull, cost dikembalikan otomatis saat player login berikutnya.
const K_SESS_REF      = "gacha:sess_ref:";

// Key untuk menyimpan string import yang di-stage via scriptevent sebelum
// dikonfirmasi lewat UI admin. Import tidak bisa dilakukan langsung dari UI
// tanpa staging ini terlebih dahulu.
const K_STAGED_IMPORT = "gacha:staged_import";

const K_REG_CHESTS    = "gacha:reg_chests";

function getAllowedChests() { return dpGet(K_REG_CHESTS, []); }
function saveAllowedChests(list) { dpSet(K_REG_CHESTS, list); }

const idleGuards = new Map();

const SFX_AREA_RADIUS = 20;
function sfxArea(location, dimension, sfxObj, excludeId = null, radius = SFX_AREA_RADIUS) {
  for (const p of world.getPlayers()) {
    if (p.id === excludeId) continue;
    if (p.dimension.id !== dimension.id) continue;
    const dx = p.location.x - location.x;
    const dy = p.location.y - location.y;
    const dz = p.location.z - location.z;
    if (dx*dx + dy*dy + dz*dz <= radius*radius) sfx(p, sfxObj);
  }
}

// ═══════════════════════════════════════════════════════════
// CHEST UTILITIES
// ═══════════════════════════════════════════════════════════
function getChestType(block) {
  try {
    const below = block.dimension.getBlock({
      x: block.location.x, y: block.location.y - 1, z: block.location.z,
    })?.typeId;
    if (below === CHEST_BASE.PARTICLE)  return "PARTICLE";
    if (below === CHEST_BASE.EQUIPMENT) return "EQUIPMENT";
  } catch {}
  return null;
}

function isChestCandidate(block) {
  if (!getChestType(block)) return false;
  const { x, y, z } = block.location, dim = block.dimension;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]])
    try { if (dim.getBlock({ x:x+dx, y, z:z+dz })?.typeId === "minecraft:chest") return false; } catch {}
  return true;
}

function isValidChest(block) {
  if (!isChestCandidate(block)) return false;
  return getAllowedChests().some(c => c.key === ck(block));
}

function nearbyValidChest(player) {
  const { x, y, z } = player.location, dim = player.dimension;
  const RX = CFG.CHEST_SCAN_R, RY = CFG.CHEST_SCAN_Y;
  for (let dx = -RX; dx <= RX; dx++)
    for (let dy = -RY; dy <= RY; dy++)
      for (let dz = -RX; dz <= RX; dz++) {
        try {
          const b = dim.getBlock({ x: Math.floor(x)+dx, y: Math.floor(y)+dy, z: Math.floor(z)+dz });
          if (b?.typeId === "minecraft:chest" && isValidChest(b)) return b;
        } catch {}
      }
  return null;
}

function nearbyValidChestCached(player) {
  const now = system.currentTick;
  const { x, y, z } = player.location;
  const posKey = `${Math.floor(x/2)*2},${Math.floor(y/2)*2},${Math.floor(z/2)*2}`;
  const cached = chestCache.get(player.id);
  if (cached && now - cached.tick < CFG.CHEST_CACHE_TTL && cached.posKey === posKey) return cached.chest;
  const chest = nearbyValidChest(player);
  chestCache.set(player.id, { chest, tick: now, posKey });
  return chest;
}

// ═══════════════════════════════════════════════════════════
// IDLE CHEST MANAGEMENT
// ═══════════════════════════════════════════════════════════
const IDLE_BORDER    = [0,1,2,3,4,5,6,7,8, 17, 26,25,24,23,22,21,20,19,18, 9];
const IDLE_INNER     = [10,11,12,14,15,16];
const IDLE_CENTER    = 13;
const IDLE_ANIM_INT  = 3;
const IDLE_COMET_LEN = 5;

function startIdleForChest(key, dimId, loc, type) {
  if (idleGuards.has(key)) return;
  const dim = world.getDimension(dimId);
  const getContainer = () => {
    try {
      const b = dim.getBlock(loc);
      return b?.typeId === "minecraft:chest"
        ? b.getComponent("minecraft:inventory")?.container ?? null
        : null;
    } catch { return null; }
  };

  const c0 = getContainer();
  if (c0) drawIdleFrame(c0, key, type, 0);

  let frame = 0;

  const intervalId = system.runInterval(() => {
    if (activeChests.has(key)) return;

    const c = getContainer();
    if (!c) { stopIdleForChest(key); return; }

    drawIdleFrame(c, key, type, frame);
    frame++;
  }, IDLE_ANIM_INT);

  idleGuards.set(key, intervalId);
}

function stopIdleForChest(key) {
  const id = idleGuards.get(key);
  if (id !== undefined) { system.clearRun(id); idleGuards.delete(key); }
}

// ═══════════════════════════════════════════════════════════
// CHEST DRAWING
// ═══════════════════════════════════════════════════════════
const mkItem = (id, name) => { const s = new ItemStack(id, 1); s.nameTag = MARK + (name ?? ""); return s; };
const clrBox = c => { for (let i = 0; i < 27; i++) c.setItem(i, undefined); };

function setSlot(container, key, slot, typeId, label) {
  container.setItem(slot, mkItem(typeId, label));
  if (!chestExpected.has(key)) chestExpected.set(key, new Array(27).fill(null));
  chestExpected.get(key)[slot] = { typeId, nameTag: MARK + (label ?? "") };
}

function fillGlass(container, key, id) {
  for (let i = 0; i < 27; i++) setSlot(container, key, i, id, " ");
}

function drawIdleFrame(container, key, type, frame) {
  if (!container) return;
  const isPt = type === "PARTICLE";

  const bg    = isPt ? "minecraft:purple_stained_glass_pane"  : "minecraft:light_blue_stained_glass_pane";
  const hiMid = isPt ? "minecraft:magenta_stained_glass_pane" : "minecraft:cyan_stained_glass_pane";
  const hiTip = isPt ? "minecraft:pink_stained_glass_pane"    : "minecraft:white_stained_glass_pane";
  const hiIn  = isPt ? "minecraft:blue_stained_glass_pane"    : "minecraft:light_gray_stained_glass_pane";
  const icon  = isPt ? "minecraft:amethyst_shard"             : "minecraft:nether_star";

  const head = frame % IDLE_BORDER.length;
  for (let bi = 0; bi < IDLE_BORDER.length; bi++) {
    const slot = IDLE_BORDER[bi];
    const dist = (bi - head + IDLE_BORDER.length) % IDLE_BORDER.length;
    let g;
    if      (dist === 0)            g = hiTip;
    else if (dist < IDLE_COMET_LEN) g = hiMid;
    else                            g = bg;
    setSlot(container, key, slot, g, " ");
  }

  const innerOn = Math.floor(frame / 10) % 2 === 0;
  for (const s of IDLE_INNER) setSlot(container, key, s, innerOn ? hiIn : bg, " ");

  const ptL = [
    "§r§5§l✦ GACHA PARTIKEL",
    "§r§d§l◈ Bayar dengan Gem",
    "§r§b§l✦ Klik untuk mulai!",
  ];
  const eqL = [
    "§r§6§l★ GACHA PERALATAN",
    "§r§e§l◈ Bayar dengan Koin",
    "§r§f§l★ Klik untuk mulai!",
  ];
  const lbl = (isPt ? ptL : eqL)[Math.floor(frame / 25) % 3];
  setSlot(container, key, IDLE_CENTER, icon, lbl);

  snapshotExpected(key);
}

function drawIdle(container, key, type) {
  drawIdleFrame(container, key, type, 0);
}

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startRolling(container, key, player, type) {
  if (!container) return { clear: () => {} };
  const isPt = type === "PARTICLE";
  const IDS  = shuffleArr(isPt ? PT_POOL.map(p => p.visual) : EQ_POOL.map(p => p.id));
  const bg   = isPt ? "minecraft:purple_stained_glass_pane" : "minecraft:light_blue_stained_glass_pane";
  fillGlass(container, key, bg);

  let tick = 0, off = Math.floor(Math.random() * IDS.length), handle = -1;
  const step = () => {
    const prog     = tick / CFG.ANIM_TICKS;
    const interval = prog < .40 ? 2 : prog < .65 ? 4 : prog < .85 ? 6 : 8;
    off = (off + 1 + Math.floor(Math.random() * 3)) % IDS.length;
    try {
      setSlot(container, key, SLOT.L2, IDS[off % IDS.length],           "§8...");
      setSlot(container, key, SLOT.L1, IDS[(off+1) % IDS.length],       "§7 ?");
      setSlot(container, key, SLOT.C,  IDS[(off+2) % IDS.length],       isPt ? "§5✦ Rolling..." : "§6★ Rolling...");
      setSlot(container, key, SLOT.R1, IDS[(off+3) % IDS.length],       "§7 ?");
      setSlot(container, key, SLOT.R2, IDS[(off+4) % IDS.length],       "§8...");
    } catch {}
    sfx(player, SFX.TICK, 1.5 - prog * .8);
    tick += interval;
    if (tick < CFG.ANIM_TICKS) handle = system.runTimeout(step, interval);
  };
  handle = system.runTimeout(step, 2);
  return { clear: () => { if (handle >= 0) { system.clearRun(handle); handle = -1; } } };
}

function reveal1x(container, item, key, player, type) {
  const { color, glass, label } = R[item.rarity];
  const itemId = type === "PARTICLE" ? item.visual : item.id;
  fillGlass(container, key, glass);
  setSlot(container, key, SLOT.T, glass, `${color}§l✦ [ ${label.toUpperCase()} ]`);
  setSlot(container, key, SLOT.C, itemId,
    item.isDup ? `${color}§l${item.name} §7[Dup]` : `${color}§l${item.name}`
  );
  setSlot(container, key, SLOT.B, glass, `${color}§l✦ [ ${label.toUpperCase()} ]`);
  sfx(player, item.isDup ? SFX.DUP : SFX.REVEAL[item.rarity]);
  sfxArea(player.location, player.dimension, item.isDup ? SFX.DUP : SFX.REVEAL[item.rarity], player.id);
  if (item.rarity === "LEGENDARY" && !item.isDup) system.runTimeout(() => { sfx(player, SFX.LEG2); sfxArea(player.location, player.dimension, SFX.LEG2, player.id); }, 10);
}

async function reveal10x(container, results, key, player, type) {
  fillGlass(container, key, "minecraft:gray_stained_glass_pane");
  for (let i = 0; i < results.length - 1; i++) {
    await wait(CFG.REVEAL_INT);
    const r = results[i], { color } = R[r.rarity];
    const itemId = type === "PARTICLE" ? r.visual : r.id;
    setSlot(container, key, i, itemId, `${color}[${r.rarity[0]}] §f${r.name}${r.isDup ? " (D)" : ""}`);
    sfx(player, r.isDup ? SFX.DUP : SFX.REVEAL[r.rarity]);
    sfxArea(player.location, player.dimension, r.isDup ? SFX.DUP : SFX.REVEAL[r.rarity], player.id);
  }
  await wait(CFG.REVEAL_PAUSE);
  const best = results[results.length - 1];
  const { glass: bg, color: bc, label: bl } = R[best.rarity];
  fillGlass(container, key, bg);
  setSlot(container, key, SLOT.T, bg, `${bc}§l ★ TERBAIK: ${bl.toUpperCase()}`);
  setSlot(container, key, SLOT.C, type === "PARTICLE" ? best.visual : best.id,
    `${bc}§l${best.name}${best.isDup ? " (D)" : ""}`
  );
  setSlot(container, key, SLOT.B, bg, `${bc}§l ★ TERBAIK: ${bl.toUpperCase()}`);
  sfx(player, best.isDup ? SFX.DUP : SFX.REVEAL[best.rarity], SFX.REVEAL[best.rarity].pitch * .75);
  sfxArea(player.location, player.dimension, best.isDup ? SFX.DUP : SFX.REVEAL[best.rarity], player.id);
  if (best.rarity === "LEGENDARY" && !best.isDup) system.runTimeout(() => { sfx(player, SFX.LEG2); sfxArea(player.location, player.dimension, SFX.LEG2, player.id); }, 10);
}

function startGuard(container, key, ownerId) {
  const guardId = system.runInterval(() => {
    const stillActive = activeChests.has(key) || isSessionOwner(key, ownerId);
    if (!stillActive) { chestExpected.delete(key); system.clearRun(guardId); return; }
    const exp = chestExpected.get(key); if (!exp) return;
    try {
      for (let slot = 0; slot < 27; slot++) {
        const e = exp[slot]; if (!e) continue;
        const actual = container.getItem(slot);
        if (!actual || actual.typeId !== e.typeId || actual.nameTag !== e.nameTag)
          container.setItem(slot, mkItem(e.typeId, e.nameTag.replace(MARK, "")));
      }
    } catch {}
    try {
      for (const p of world.getPlayers()) {
        const inv = p.getComponent("minecraft:inventory")?.container; if (!inv) continue;
        for (let s = 0; s < inv.size; s++) {
          if (isMark(inv.getItem(s))) {
            inv.setItem(s, undefined);
            p.sendMessage("§c⚠ Item gacha tidak bisa diambil!");
          }
        }
      }
    } catch {}
  }, 2);
  return guardId;
}

function waitChestOpen(player, block) {
  const key = ck(block);
  return new Promise((resolve, reject) => {
    let subI, subL;
    const cleanup = () => {
      try { world.afterEvents.playerInteractWithBlock.unsubscribe(subI); } catch {}
      try { world.afterEvents.playerLeave.unsubscribe(subL); } catch {}
    };
    const tid = system.runTimeout(() => { cleanup(); reject(new Error("timeout")); }, CFG.OPEN_TIMEOUT);
    subL = world.afterEvents.playerLeave.subscribe(ev => {
      if (ev.playerId !== player.id) return;
      system.clearRun(tid); cleanup(); reject(new Error("timeout"));
    });
    subI = world.afterEvents.playerInteractWithBlock.subscribe(ev => {
      if (ev.player.id !== player.id || ev.block.typeId !== "minecraft:chest" || ck(ev.block) !== key) return;
      system.clearRun(tid); cleanup(); resolve();
    });
  });
}

function broadcastRare(pName, items, type) {
  const pfx = type === "PARTICLE" ? "§5[PT]" : "§6[EQ]";
  for (const item of items) {
    if (item.isDup || R_KEYS.indexOf(item.rarity) < 3) continue;
    const col = R[item.rarity].color;
    if (item.rarity === "LEGENDARY")
      world.sendMessage(`§6§l[★★ LEGENDARY ★★]\n§r${pfx} §e${pName} §fmendapat ${col}§l${item.name}§r§f!`);
    else
      world.sendMessage(`${pfx} ${col}${pName} §fmendapat ${col}§l${item.name}§r§f! §8[${R[item.rarity].label}]`);
  }
}

// ═══════════════════════════════════════════════════════════
// SESSION MENUS
// ═══════════════════════════════════════════════════════════
async function showParticleSession(player) {
  while (true) {
    const ptSr    = tGet(player, T.PTPY, 0);
    const ptSt    = getStats(CFG.K_PT_STATS, player);
    const ptCol   = PT_POOL.filter(p => player.hasTag(p.tag)).length;
    const disc    = pendingDisc.get(player.id);
    const hasDisc = disc && (disc.type === "ALL" || disc.type === "PT");
    const cost1   = hasDisc ? Math.max(1, Math.floor(CFG.PT_COST_1  * (1 - disc.pct/100))) : CFG.PT_COST_1;
    const cost10  = hasDisc ? Math.max(1, Math.floor(CFG.PT_COST_10 * (1 - disc.pct/100))) : CFG.PT_COST_10;
    const isAdmin = player.hasTag(CFG.ADMIN_TAG);

    let body = `§b✦ Gem: §f${getGem(player)}  §8|  §5Koleksi: §f${ptCol}§7/§f${PT_POOL.length}\n`;
    body += `§7Pity: ${bar(ptSr, CFG.PT_PITY_RARE)} §f${ptSr}/${CFG.PT_PITY_RARE}  §7Pull: §f${ptSt.total}x`;
    if (hasDisc) body += `  §a(-${disc.pct}%)`;
    body += `\n${HR}`;
    if (ptSt.last.length) {
      body += `\n§e5 Terakhir:\n`;
      ptSt.last.slice(0, 5).forEach((e, i) => { body += ` §f${i+1}. ${fmtShort(e)}\n`; });
    }

    const btns = ["pull1","pull10","info","disc","global",...(isAdmin ? ["admin"] : []),"close"];
    const form = new ActionFormData()
      .title("§l§5  ✦ GACHA PARTIKEL ✦  §r").body(body)
      .button(`§l Pull 1x\n§r§b${cost1} Gem${hasDisc ? ` §a(-${disc.pct}%)` : ""}`)
      .button(`§l Pull 10x\n§r§b${cost10} Gem${hasDisc ? ` §a(-${disc.pct}%)` : ""}`)
      .button("§l Info Reward")
      .button("§l Kode Diskon")
      .button("§l History Global");
    if (isAdmin) form.button("§l [ADMIN]");
    form.button("§l Tutup");

    sfx(player, SFX.OPEN);
    const res = await form.show(player);
    if (res.canceled) return null;
    const action = btns[res.selection];

    if (action === "close")  return null;
    if (action === "info")   { await showRewardInfo(player, "PARTICLE"); continue; }
    if (action === "disc")   { await showDiscountInput(player, "PARTICLE"); continue; }
    if (action === "global") { await showGlobalHistory(player); continue; }
    if (action === "admin")  { await showAdminMenu(player); continue; }

    const is10x = action === "pull10";
    const cost  = is10x ? cost10 : cost1;
    if (getGem(player) < cost) {
      sfx(player, SFX.BROKE);
      const err = await showNoBal(player, cost, "PARTICLE");
      if (err.canceled || err.selection !== 1) return null;
      continue;
    }
    return { type: "PARTICLE", is10x, cost };
  }
}

async function showEquipmentSession(player) {
  while (true) {
    const eqPity  = dpGet(CFG.K_EQ_PITY + player.id, { sr:0, l:0 });
    const eqSt    = getStats(CFG.K_EQ_STATS, player);
    const pend    = getPend(player);
    const disc    = pendingDisc.get(player.id);
    const hasDisc = disc && (disc.type === "ALL" || disc.type === "EQ");
    const cost1   = hasDisc ? Math.max(1, Math.floor(CFG.EQ_COST_1  * (1 - disc.pct/100))) : CFG.EQ_COST_1;
    const cost10  = hasDisc ? Math.max(1, Math.floor(CFG.EQ_COST_10 * (1 - disc.pct/100))) : CFG.EQ_COST_10;
    const free    = freeSlots(player);
    const isAdmin = player.hasTag(CFG.ADMIN_TAG);

    let body = `§e★ Koin: §f${getCoin(player)}`;
    if (pend.length > 0) body += `  §c⚠ [${pend.length} pending!]`;
    body += `\n§7Rare+: ${bar(eqPity.sr, CFG.EQ_PITY_RARE)} §f${eqPity.sr}/${CFG.EQ_PITY_RARE}\n`;
    body += `§7Leg  : ${bar(eqPity.l, CFG.EQ_PITY_LEG)} §f${eqPity.l}/${CFG.EQ_PITY_LEG}  §7Pull: §f${eqSt.total}x`;
    if (hasDisc) body += `  §a(-${disc.pct}%)`;
    if (free < 1) body += `\n§c⚠ Inventory penuh!`;
    body += `\n${HR}`;
    if (eqSt.last.length) {
      body += `\n§e5 Terakhir:\n`;
      eqSt.last.slice(0, 5).forEach((e, i) => { body += ` §f${i+1}. ${fmtShort(e)}\n`; });
    }

    const btns = [];
    const form = new ActionFormData().title("§l§6  ★ GACHA PERALATAN ★  §r").body(body);
    if (free >= 1) {
      form.button(`§l Pull 1x\n§r§e${cost1} Koin${hasDisc ? ` §a(-${disc.pct}%)` : ""}`);  btns.push("pull1");
      form.button(`§l Pull 10x\n§r§e${cost10} Koin${hasDisc ? ` §a(-${disc.pct}%)` : ""}`); btns.push("pull10");
    } else {
      form.button("§l Pull 1x §8(inv penuh)\n§r§8Kosongkan inventory"); btns.push("noop");
      form.button("§l Pull 10x §8(inv penuh)\n§r§8Kosongkan inventory"); btns.push("noop");
    }
    form.button(`§l Klaim Pending (${pend.length})`);  btns.push("claim");
    form.button("§l Info Reward");                        btns.push("info");
    form.button("§l Kode Diskon");                        btns.push("disc");
    form.button("§l History Global");                     btns.push("global");
    if (isAdmin) { form.button("§l [ADMIN]"); btns.push("admin"); }
    form.button("§l Tutup"); btns.push("close");

    sfx(player, SFX.OPEN);
    const res = await form.show(player);
    if (res.canceled) return null;
    const action = btns[res.selection];

    if (action === "close")  return null;
    if (action === "noop")   { player.sendMessage("§c⚠ Kosongkan minimal 1 slot!"); continue; }
    if (action === "info")   { await showRewardInfo(player, "EQUIPMENT"); continue; }
    if (action === "disc")   { await showDiscountInput(player, "EQUIPMENT"); continue; }
    if (action === "global") { await showGlobalHistory(player); continue; }
    if (action === "admin")  { await showAdminMenu(player); continue; }
    if (action === "claim") {
      const n = claimPend(player), rem = getPend(player).length;
      n > 0
        ? (sfx(player, SFX.CLAIM), player.sendMessage(`§a[+] ${n} item diklaim!${rem ? ` §e(${rem} pending)` : ""}`))
        : player.sendMessage(pend.length ? "§c[X] Inventory penuh!" : "§7Tidak ada pending.");
      continue;
    }

    const is10x = action === "pull10";
    const cost  = is10x ? cost10 : cost1;
    if (getCoin(player) < cost) {
      sfx(player, SFX.BROKE);
      const err = await showNoBal(player, cost, "EQUIPMENT");
      if (err.canceled || err.selection !== 1) return null;
      continue;
    }
    return { type: "EQUIPMENT", is10x, cost };
  }
}

// ═══════════════════════════════════════════════════════════
// HUB MENU
// ═══════════════════════════════════════════════════════════
async function showHubMenu(player) {
  while (true) {
    const ptSt    = getStats(CFG.K_PT_STATS, player);
    const eqSt    = getStats(CFG.K_EQ_STATS, player);
    const pend    = getPend(player);
    const isAdmin = player.hasTag(CFG.ADMIN_TAG);

    let body =
      `§b✦ Gem: §f${getGem(player)}  §e Koin: §f${getCoin(player)}\n` +
      `§5Partikel: §f${PT_POOL.filter(p => player.hasTag(p.tag)).length}§7/§f${PT_POOL.length}  §7Pull PT:§f${ptSt.total}x  EQ:§f${eqSt.total}x\n`;
    if (pend.length) body += `§c⚠ ${pend.length} item pending — buka menu EQ untuk klaim!\n`;
    body += `${HR}\n§7Pegang §fAmethyst Shard §7dan klik kanan di udara.\n${HR}`;

    const btns = [];
    const form = new ActionFormData().title("§l§d  ✦ GACHA HUB ✦  §r").body(body);
    form.button(`§l Gacha Partikel\n§r§b${CFG.PT_COST_1} Gem / 1x`); btns.push("pt");
    form.button(`§l Gacha Peralatan\n§r§e${CFG.EQ_COST_1} Koin / 1x`); btns.push("eq");
    form.button("§l Leaderboard");   btns.push("lb");
    form.button("§l Statistik Saya"); btns.push("stats");
    form.button("§l History Global");     btns.push("global");
    if (isAdmin) { form.button("§l [ADMIN]"); btns.push("admin"); }
    form.button("§l Tutup"); btns.push("close");

    sfx(player, SFX.OPEN);
    const res = await form.show(player);
    if (res.canceled) return;
    const action = btns[res.selection];

    if (action === "close")  return;
    if (action === "global") { await showGlobalHistory(player); continue; }
    if (action === "admin")  { await showAdminMenu(player); continue; }
    if (action === "lb")     { await showLeaderboard(player); continue; }
    if (action === "stats")  { await showMyStats(player); continue; }

    if (action === "pt" || action === "eq") {
      const intent = action === "pt"
        ? await showParticleSession(player)
        : await showEquipmentSession(player);
      if (!intent) continue;
      await executeGachaIntent(player, intent, null);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// GACHA LOGIC
// ═══════════════════════════════════════════════════════════
async function executeGachaIntent(player, intent, block) {
  const { type, is10x, cost } = intent;
  const unit = type === "PARTICLE" ? "Gem" : "Koin";

  if (type === "EQUIPMENT" && freeSlots(player) < 1) {
    sfx(player, SFX.BROKE);
    player.sendMessage("§c⚠ Inventory penuh!");
    return;
  }

  const chestBlock = block ?? nearbyValidChest(player);

  if (!chestBlock || !isValidChest(chestBlock)) {
    sfx(player, SFX.BROKE);
    player.sendMessage(
      `§c[Gacha] ⚠ Tidak ada chest gacha terdaftar di dekatmu!\n` +
      `§7Minta admin untuk mendaftarkan chest terlebih dahulu.\n` +
      `§7Kamu belum dikenakan biaya.`
    );
    return;
  }

  const key = ck(chestBlock);
  if (activeChests.has(key)) {
    sfx(player, SFX.BROKE);
    player.sendMessage("§e[!] Chest sedang digunakan orang lain! Coba chest lain.");
    return;
  }

  const paid = await withLock(player.id, async () => deduct(type, player, cost));
  if (!paid) {
    sfx(player, SFX.BROKE);
    await showNoBal(player, cost, type);
    return;
  }

  const balAfterDeduct = type === "PARTICLE" ? getGem(player) : getCoin(player);

  if (activeChests.has(key)) {
    sfx(player, SFX.BROKE);
    await withLock(player.id, async () => refund(type, player, cost));
    player.sendMessage(`§e[!] Chest baru saja diambil player lain! §f${cost} ${unit} dikembalikan.`);
    return;
  }

  const disc     = pendingDisc.get(player.id);
  const baseCost = is10x
    ? (type === "PARTICLE" ? CFG.PT_COST_10 : CFG.EQ_COST_10)
    : (type === "PARTICLE" ? CFG.PT_COST_1  : CFG.EQ_COST_1);
  const dim = player.dimension;

  // [FIX RESTART] Pessimistic refund: simpan cost ke DP sebelum session aktif.
  // Jika server restart di tengah pull, cost dikembalikan otomatis saat player login.
  // Dihapus di finally setelah session selesai dengan aman.
  const sessRefKey = K_SESS_REF + player.id;
  dpSet(sessRefKey, { type, cost });

  sfx(player, SFX.PAY);

  const loc   = { ...chestBlock.location };
  const fresh = () => {
    try {
      const b = dim.getBlock(loc);
      return b?.typeId === "minecraft:chest"
        ? b.getComponent("minecraft:inventory")?.container ?? null
        : null;
    } catch { return null; }
  };

  if (!fresh()) {
    dpDel(sessRefKey);
    await withLock(player.id, async () => refund(type, player, cost));
    player.sendMessage(`§c[Gacha] ⚠ Chest hilang! §f${cost} ${unit} dikembalikan.`);
    lastPull.set(player.id, system.currentTick);
    return;
  }

  activeChests.set(key, player.id);
  persistLock(key, player.id);
  const c0 = fresh();
  if (c0) { stopIdleForChest(key); drawIdle(c0, key, type); startGuard(c0, key, player.id); }
  sfx(player, SFX.READY);
  sfxArea(chestBlock.location, chestBlock.dimension, SFX.READY, player.id);

  await new ActionFormData()
    .title("§l§a  ★ Siap!  §r")
    .body(
      `${HR}\n§a Pembayaran berhasil!\n§f ${cost} ${unit} dipotong.\n` +
      `${HR}\n§e Buka chest ini untuk hasil!\n${HR}`
    )
    .button("§l Buka Chest Sekarang!")
    .show(player);

  try {
    await waitChestOpen(player, chestBlock);

    if (disc) {
      pendingDisc.delete(player.id);
      validateAndConsumeDisc(disc.code, type, player.id);
    }

    const c = fresh();
    if (!c) throw new Error("Chest hilang.");
    await doGacha(player, c, key, type, is10x, baseCost);

  } catch (err) {
    const isStillOnline = world.getPlayers().some(p => p.id === player.id);
    if (isStillOnline) {
      await withLock(player.id, async () => refund(type, player, cost));
    } else {
      // Player offline di tengah session: simpan refund ke pend key.
      // sessRefKey sudah di-set di atas, tapi saat offline kita perlu
      // menghapus sessRefKey dan set pend key agar tidak double refund saat login.
      try {
        dpDel(sessRefKey);
        const pendKey  = type === "PARTICLE" ? (K_PEND_GEM + player.id) : (K_PEND_COIN + player.id);
        const existing = dpGet(pendKey, null);
        const refundVal = existing !== null ? existing + cost : balAfterDeduct + cost;
        dpSet(pendKey, refundVal);
        console.warn(`[Gacha] Offline refund pending for ${player.name}: set to ${refundVal} ${unit}`);
      } catch (refundErr) {
        console.error("[Gacha] CRITICAL: offline refund failed for", player.name, refundErr);
      }
    }

    if (err.message === "timeout") {
      sfx(player, SFX.TIMEOUT);
      player.sendMessage(`§c[Gacha] ⚠ Waktu habis! §f${cost} ${unit} dikembalikan.`);
    } else {
      console.error("[Gacha] Error:", err);
      player.sendMessage(`§c[Gacha] ⚠ Error! §f${cost} ${unit} dikembalikan.`);
    }
  } finally {
    // [FIX RESTART] Hapus pessimistic refund — session selesai normal atau sudah
    // ditangani di catch (offline). Tidak ada double refund saat login berikutnya.
    dpDel(sessRefKey);
    clearLock(key);
    try { const c = fresh(); if (c) clrBox(c); } catch {}
    lastPull.set(player.id, system.currentTick);
    const regEntry = getAllowedChests().find(c => c.key === key);
    if (regEntry) system.runTimeout(() => startIdleForChest(key, regEntry.dimId, { x: regEntry.x, y: regEntry.y, z: regEntry.z }, regEntry.type), 5);
  }
}

async function doGacha(player, container, key, type, is10x, baseCost) {
  const rollFn = type === "PARTICLE" ? rollPt : rollEq;
  const statsK = type === "PARTICLE" ? CFG.K_PT_STATS : CFG.K_EQ_STATS;
  while (true) {
    const rawResults     = is10x ? rollMany(rollFn, player, 10) : [rollFn(player)];
    const displayResults = preCheckDupBatch(player, rawResults, type);
    const anim = startRolling(container, key, player, type);
    await wait(CFG.ANIM_TICKS + 5);
    anim.clear();
    if (is10x) await reveal10x(container, displayResults, key, player, type);
    else        reveal1x(container, displayResults[0], key, player, type);
    await wait(is10x ? 70 : 50);
    const results = rawResults.map(r => applyReward(player, r, type));
    results.sort((a, b) => R_KEYS.indexOf(a.rarity) - R_KEYS.indexOf(b.rarity));
    recordStats(statsK, player, results);
    pushPlayerHist(player, results, type);
    pushGlobalHist(player.name, results, type);
    broadcastRare(player.name, results, type);
    const res = await showResultForm(player, results, is10x, type, baseCost);
    if (res.canceled || res.selection !== 1) break;
    if (type === "EQUIPMENT" && freeSlots(player) < 1) {
      sfx(player, SFX.BROKE); player.sendMessage("§c⚠ Inventory penuh!"); break;
    }
    const ok = await withLock(player.id, async () => deduct(type, player, baseCost));
    if (!ok) { sfx(player, SFX.BROKE); await showNoBal(player, baseCost, type); break; }
    sfx(player, SFX.PAY);
    for (let i = 0; i < 3; i++) { await wait(8); sfx(player, SFX.TICK, 1.5 - i * 0.3); }
  }
}

async function startGacha(player, block, chestType) {
  const claimed = claimPend(player);
  if (claimed > 0) { sfx(player, SFX.CLAIM); player.sendMessage(`§a[+] ${claimed} item diklaim otomatis.`); }
  const intent = chestType === "PARTICLE"
    ? await showParticleSession(player)
    : await showEquipmentSession(player);
  if (intent) await executeGachaIntent(player, intent, block);
}

// ═══════════════════════════════════════════════════════════
// LEADERBOARD & STATISTIK
// ═══════════════════════════════════════════════════════════
async function showLeaderboard(player) {
  const TABS = [
    { label: "Gem",           key: "gem",        unit: "G",  col: "§b" },
    { label: "Koin",          key: "coin",       unit: "K",  col: "§e" },
    { label: "Koleksi PT",    key: "ptCount",    unit: "PT", col: "§5" },
    { label: "Total Pull",    key: "totalPulls", unit: "x",  col: "§e" },
    { label: "Pull Partikel", key: "ptPulls",    unit: "x",  col: "§d" },
    { label: "Pull Peralatan",key: "eqPulls",    unit: "x",  col: "§6" },
  ];
  let tabIdx = 0;

  while (true) {
    const tab     = TABS[tabIdx];
    const entries = getLeaderboard(tab.key, CFG.LB_LIMIT);
    const medals  = ["§6①","§7②","§e③"];

    let body = `${HR}\n`;
    if (!entries.length) {
      body += "§7(Belum ada data player)\n";
    } else {
      entries.forEach((e, i) => {
        const rank   = i < 3 ? medals[i] : `§7${i+1}.`;
        const online = e.isOnline ? " §a●" : "";
        const val    = tab.key === "ptCount" ? `${e.ptCount}§7/§f${PT_POOL.length}` : e[tab.key];
        body += `${rank} §f${e.name}${online}  ${tab.col}${val} ${tab.unit}\n`;
      });
    }
    body += HR;

    const form = new ActionFormData()
      .title(`§l§e  ★ LEADERBOARD: ${tab.label}  §r`)
      .body(body);
    TABS.forEach((t, i) => form.button(i === tabIdx ? `§a> ${t.label}` : `§f${t.label}`));
    form.button("§l Kembali");

    sfx(player, SFX.OPEN);
    const res = await form.show(player);
    if (res.canceled || res.selection === TABS.length) return;
    tabIdx = res.selection;
  }
}

async function showMyStats(player) {
  const ptSt   = getStats(CFG.K_PT_STATS, player);
  const eqSt   = getStats(CFG.K_EQ_STATS, player);
  const ptSr   = tGet(player, T.PTPY, 0);
  const eqPity = dpGet(CFG.K_EQ_PITY + player.id, { sr:0, l:0 });
  const ptCol  = PT_POOL.filter(p => player.hasTag(p.tag)).length;
  const pend   = getPend(player);
  const hist   = dpGet(CFG.K_HIST + player.id, []);

  let body = `${HR}\n§b✦ Gem: §f${getGem(player)}  §e★ Koin: §f${getCoin(player)}\n${HR}\n`;
  body += `§5§l[ PARTIKEL ]\n`;
  body += `§7Koleksi  : §f${ptCol}§7/§f${PT_POOL.length} (${(ptCol/PT_POOL.length*100).toFixed(0)}%)\n`;
  body += `§7Total Pull: §f${ptSt.total}x\n`;
  body += `§7Pity      : ${bar(ptSr, CFG.PT_PITY_RARE)} §f${ptSr}/${CFG.PT_PITY_RARE}\n`;
  body += `§7Rarity    : ` + R_KEYS.map(k => `${R[k].color}${k[0]}:${ptSt.by[k]??0}`).join("§8, ") + "\n";
  body += `${HR}\n§6§l[ PERALATAN ]\n`;
  body += `§7Total Pull : §f${eqSt.total}x\n`;
  body += `§7Pity Rare+ : ${bar(eqPity.sr, CFG.EQ_PITY_RARE)} §f${eqPity.sr}/${CFG.EQ_PITY_RARE}\n`;
  body += `§7Pity Leg   : ${bar(eqPity.l, CFG.EQ_PITY_LEG)} §f${eqPity.l}/${CFG.EQ_PITY_LEG}\n`;
  body += `§7Rarity     : ` + R_KEYS.map(k => `${R[k].color}${k[0]}:${eqSt.by[k]??0}`).join("§8, ") + "\n";
  if (pend.length) body += `§c⚠ Pending: §f${pend.length} item\n`;
  body += `${HR}\n`;
  if (hist.length) {
    body += "§e10 Pull Terakhir:\n";
    hist.slice(0, 10).forEach((h, i) => {
      body += `§f${i+1}. [${h.t === "PT" ? "§5PT" : "§6EQ"}§f] ${R[h.r]?.color ?? "§f"}${h.n}${h.d ? " §7(D)" : ""}\n`;
    });
  }

  await new ActionFormData()
    .title(`§l§b  ★ STATISTIK — ${player.name}  §r`)
    .body(body).button("§l Kembali").show(player);
}

// ═══════════════════════════════════════════════════════════
// MENU PENDUKUNG
// ═══════════════════════════════════════════════════════════
async function showGlobalHistory(player) {
  const hist = dpGet(CFG.K_GLOBAL_HIST, []);
  let body = `${HR}\n§e★ Recent Pulls\n${HR}\n`;
  if (!hist.length) body += "§7(Belum ada pull tercatat)\n";
  else hist.forEach((h, i) => {
    body += `§f${i+1}. §a${h.p} §8[${h.t === "PT" ? "§5PT" : "§6EQ"}§8]\n   ${R[h.r]?.color ?? "§f"}${h.n} §8(${h.r[0]})\n`;
  });
  body += `\n${HR}`;
  await new ActionFormData().title("§l§e  ★ GLOBAL HISTORY ★  §r").body(body).button("§l Kembali").show(player);
}

async function showRewardInfo(player, type) {
  const isPt = type === "PARTICLE", pool = isPt ? PT_POOL : EQ_POOL;
  const totalW = isPt ? PT_TOTAL_W : EQ_TOTAL_W, wKey = isPt ? "ptW" : "eqW";
  let body = `${HR}\n`;
  for (const rk of R_KEYS) {
    const items = pool.filter(i => i.rarity === rk); if (!items.length) continue;
    body += `${R[rk].color}§l[${rk[0]}] ${R[rk].label} — ${pctStr(R[rk][wKey], totalW)}%\n`;
    items.forEach(item => { body += `  §7• §f${item.name}${isPt && player.hasTag(item.tag) ? " §a[✔]" : ""}\n`; });
  }
  body += `${HR}\n`;
  body += isPt
    ? `§7Pity Rare+: tiap §e${CFG.PT_PITY_RARE}x  §7Dup: §b+${CFG.GEM_REFUND} Gem\n`
    : `§7Pity Rare+: §e${CFG.EQ_PITY_RARE}x  §7Legend: §e${CFG.EQ_PITY_LEG}x\n`;
  await new ActionFormData()
    .title(isPt ? "§l§5  INFO PARTIKEL  §r" : "§l§6  INFO PERALATAN  §r")
    .body(body).button("§l Kembali").show(player);
}

async function showDiscountInput(player, gachaType) {
  const cur  = pendingDisc.get(player.id);
  const hint = cur ? `§aAktif: ${cur.code} (-${cur.pct}%)\n§fKode baru / kosongkan utk hapus:` : "§fMasukkan kode:";
  const res  = await new ModalFormData().title("§l§e  Kode Diskon  §r")
    .textField(hint, "Contoh: HEMAT50", "").show(player);
  if (res.canceled) return;
  const raw = String(res.formValues?.[0] ?? "").trim().toUpperCase();
  if (!raw) { if (cur) { pendingDisc.delete(player.id); player.sendMessage("§7[Diskon] Kode dihapus."); } return; }
  if (hasUsedCode(player.id, raw)) { player.sendMessage(`§c[X] Kamu sudah memakai kode §f"${raw}"§c.`); return; }
  const entry = validateDisc(raw, gachaType, player.id);
  if (!entry) { player.sendMessage(`§c[X] Kode §f"${raw}"§c tidak valid atau habis.`); return; }
  const typeLbl = entry.type === "PT" ? "Partikel" : entry.type === "EQ" ? "Peralatan" : "Semua";
  pendingDisc.set(player.id, { code: raw, pct: entry.pct, type: entry.type });
  player.sendMessage(`§a[+] Kode §f${raw} §aaktif! Diskon §f${entry.pct}% §a(${typeLbl})`);
}

async function showNoBal(player, needed, type) {
  const isPt = type === "PARTICLE", unit = isPt ? "Gem" : "Koin";
  const cur  = isPt ? getGem(player) : getCoin(player);
  return new ActionFormData().title("§c  ⚠ Saldo Kurang  §r")
    .body(`${HR}\n§f Butuh : §c${needed} ${unit}\n§f Punya  : §e${cur} ${unit}\n${HR}\n` +
      (isPt ? "§7Gem dari top-up atau event." : "§7Kumpulkan koin di dalam game!"))
    .button("§l Oke").button("§l Kembali").show(player);
}

async function showResultForm(player, results, is10x, type, baseCost) {
  const isPt = type === "PARTICLE", unit = isPt ? " Gem" : " Koin";
  const cur  = isPt ? getGem(player) : getCoin(player);
  if (is10x) {
    const best = results[results.length - 1];
    const { color: bc, label: bl } = R[best.rarity];
    let body = results.some(r => r.rarity === "LEGENDARY" && !r.isDup) ? "§6§l  [LEGENDARY]\n\n" : "";
    body += `§f10x Pull:\n${HR}\n`;
    results.forEach((r, i) => {
      body += `§f${i+1}. ${R[r.rarity].color}[${r.rarity[0]}] §f${r.name}${r.isDup ? " §7(D)" : (isPt ? " §a[+]" : "")}\n`;
    });
    body += `${HR}\n`;
    if (isPt) { const dc = results.filter(r => r.isDup).length; if (dc) body += `§e${dc} dup -> §b+${dc * CFG.GEM_REFUND} Gem\n`; }
    body += `§f Best: ${bc}§l[${bl}] ${best.name}\n§f Sisa: §e${cur}${unit}`;
    return new ActionFormData().title("§l  HASIL 10x  §r").body(body)
      .button("§l Selesai").button(`§l Pull 10x Lagi - ${baseCost} ${unit}`).show(player);
  } else {
    const r = results[0], { color, label } = R[r.rarity];
    let body = r.rarity === "LEGENDARY" && !r.isDup ? "§6§l  [LEGENDARY]\n\n" : "";
    body += `${HR}\n${color}§l[ ${label.toUpperCase()} ]\n§f ${r.name}\n${HR}\n`;
    body += isPt ? (r.isDup ? `§e Dup! §b+${CFG.GEM_REFUND} Gem\n` : "§a Partikel baru!\n") : "§7 Masuk inventory / pending.\n";
    body += `§f Sisa: §e${cur}${unit}`;
    return new ActionFormData().title("§l  HASIL PULL  §r").body(body)
      .button("§l Selesai").button(`§l Pull 1x Lagi - ${baseCost} ${unit}`).show(player);
  }
}

// ═══════════════════════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════════════════════
async function showAdminMenu(player) {
  if (!player.hasTag(CFG.ADMIN_TAG)) { player.sendMessage("§c[!] Akses ditolak."); return; }
  while (true) {
    const codes      = getDiscCodes();
    const reg        = getPlayerReg();
    const pendImps   = Object.keys(reg).filter(id => dpGet(CFG.K_IMPORT_PEND + id, null) !== null).length;
    const regChests  = getAllowedChests();
    const hasStagedImport = dpGet(K_STAGED_IMPORT, null) !== null;

    const form = new ActionFormData().title("§l§c  ADMIN PANEL  §r")
      .body(
        `${HR}\n§c§lADMIN  §7| §fLogin: §a${player.name}  §7Online: §f${world.getPlayers().length}\n` +
        `§7Kode: §f${Object.keys(codes).length}  §7| §7Player: §f${Object.keys(reg).length}\n` +
        `§7Chest Terdaftar: §a${regChests.length}\n` +
        (pendImps ? `§e⚠ Pending import: ${pendImps} player\n` : "") +
        (hasStagedImport ? `§b⚡ Data import siap dikonfirmasi!\n` : "") +
        HR
      )
      .button("§l Kelola Gem Player")
      .button("§l Kelola Koin Player")
      .button("§l Buat Kode Diskon")
      .button("§l Hapus Kode Diskon")
      .button("§l Lihat Semua Kode")
      .button("§l Export / Import Semua")
      .button("§l Cara Daftarkan Chest")
      .button("§l Kelola Chest Terdaftar")
      .button("§l Kembali");

    sfx(player, SFX.ADMIN);
    const res = await form.show(player);
    if (res.canceled || res.selection === 8) return;
    if      (res.selection === 0) await showAdminPlayerSelect(player, "gem");
    else if (res.selection === 1) await showAdminPlayerSelect(player, "coin");
    else if (res.selection === 2) await showAdminCreateCode(player);
    else if (res.selection === 3) await showAdminDeleteCode(player);
    else if (res.selection === 4) await showAdminListCodes(player);
    else if (res.selection === 5) await showExportImportAllUI(player);
    else if (res.selection === 6) await showAdminRegisterChest(player);
    else if (res.selection === 7) await showAdminManageChests(player);
  }
}

async function showAdminPlayerSelect(adminPlayer, currency) {
  while (true) {
    const onlinePlrs = world.getPlayers();
    const reg        = getPlayerReg();
    const onlineIds  = new Set(onlinePlrs.map(p => p.id));
    const allPlayers = [
      ...onlinePlrs.map(p => ({ id: p.id, name: p.name, isOnline: true, playerObj: p })),
      ...Object.entries(reg).filter(([id]) => !onlineIds.has(id))
        .map(([id, info]) => ({ id, name: info.name, isOnline: false, playerObj: null })),
    ].sort((a, b) => { if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1; return a.name.localeCompare(b.name); });

    if (!allPlayers.length) { adminPlayer.sendMessage("§c[!] Tidak ada player tersimpan."); return; }

    const form = new ActionFormData()
      .title(`§l§b  Pilih Player — ${currency === "gem" ? "Gem" : "Koin"}  §r`)
      .body(`${HR}\n§aHijau = online  §7Abu = offline\n${HR}`);
    for (const p of allPlayers) {
      const gemVal  = p.isOnline ? getGem(p.playerObj)  : (reg[p.id]?.gem  ?? 0);
      const coinVal = p.isOnline ? getCoin(p.playerObj) : (reg[p.id]?.coin ?? 0);
      const pendG   = dpGet(K_PEND_GEM  + p.id, null) !== null ? " §e[pend]" : "";
      const pendC   = dpGet(K_PEND_COIN + p.id, null) !== null ? " §e[pend]" : "";
      form.button(
        `${p.isOnline ? "§a●" : "§7○"} §f${p.name}\n` +
        `${currency === "gem" ? `§b${gemVal} gem${pendG}` : `§e${coinVal} koin${pendC}`}`
      );
    }
    form.button("§l Kembali");
    const res = await form.show(adminPlayer);
    if (res.canceled || res.selection === allPlayers.length) return;

    const selected = allPlayers[res.selection];
    if (selected.isOnline) {
      const target = world.getPlayers().find(p => p.id === selected.id);
      if (!target) { adminPlayer.sendMessage(`§c[!] §f${selected.name} §csudah offline.`); continue; }
      const acted = await showAdminAction(adminPlayer, target, currency);
      if (acted) return;
    } else {
      const acted = await showAdminActionOffline(adminPlayer, selected, currency, reg);
      if (acted) return;
    }
  }
}

async function showAdminAction(adminPlayer, target, currency) {
  const isGem = currency === "gem";
  while (true) {
    const live = world.getPlayers().find(p => p.name === target.name);
    if (!live) { adminPlayer.sendMessage(`§c[!] §f${target.name} §csudah offline.`); return false; }
    const curBal = isGem ? getGem(live) : getCoin(live);
    const form = new ActionFormData()
      .title(`§l  ${isGem ? "Gem" : "Koin"} — ${live.name}  §r`)
      .body(`${HR}\n§f ${live.name}  ${isGem ? "§b" : "§e"}${curBal} ${currency}\n${HR}`)
      .button("§l Tambah").button("§l Kurangi").button("§l Set Nilai").button("§l Kembali");
    const res = await form.show(adminPlayer);
    if (res.canceled || res.selection === 3) return false;
    const done = await showAdminAmountInput(adminPlayer, live, currency, ["add","remove","set"][res.selection]);
    if (done) return true;
  }
}

async function showAdminAmountInput(adminPlayer, target, currency, action) {
  const isGem  = currency === "gem";
  const curBal = isGem ? getGem(target) : getCoin(target);
  const actLbl = action === "add" ? "Tambah" : action === "remove" ? "Kurangi" : "Set";
  const res    = await new ModalFormData()
    .title(`§l  ${actLbl} ${isGem ? "Gem" : "Koin"} — ${target.name}`)
    .textField(`§f${actLbl} §7(sekarang: §f${curBal}§7)`, "Contoh: 100", "0").show(adminPlayer);
  if (res.canceled) return false;
  const amount = Math.floor(Number(String(res.formValues?.[0] ?? "0").trim()));
  if (!Number.isFinite(amount) || amount < 0) { adminPlayer.sendMessage("§c[!] Angka tidak valid."); return false; }
  if (amount === 0 && (action === "add" || action === "remove")) {
    adminPlayer.sendMessage("§c[!] Jumlah harus lebih dari 0 untuk Tambah/Kurangi."); return false;
  }
  const success = await withLock(target.id, async () => {
    if (isGem) {
      if (action === "add")         setGem(target, getGem(target) + amount);
      else if (action === "remove") setGem(target, Math.max(0, getGem(target) - amount));
      else if (action === "set")    setGem(target, amount);
    } else {
      const cur = getCoin(target);
      if (action === "add")         setScore(CFG.COIN_OBJ, target, cur + amount);
      else if (action === "remove") setScore(CFG.COIN_OBJ, target, Math.max(0, cur - amount));
      else if (action === "set")    setScore(CFG.COIN_OBJ, target, amount);
    }
    return true;
  });
  if (success) {
    const newBal = isGem ? getGem(target) : getCoin(target);
    adminPlayer.sendMessage(`§a[Admin] ${actLbl} §f${amount} ${currency} -> §a${target.name}§f. Baru: §e${newBal}`);
    sfx(adminPlayer, SFX.ADMIN);
    target.sendMessage(`§a[+] Saldo ${currency} diperbarui: §e${newBal}`);
    if (isGem) syncPlayerData(target);
    return true;
  }
  adminPlayer.sendMessage("§c[Admin] Gagal. Coba lagi."); return false;
}

async function showAdminActionOffline(adminPlayer, target, currency, reg) {
  const isGem  = currency === "gem";
  const pendKey = isGem ? (K_PEND_GEM + target.id) : (K_PEND_COIN + target.id);
  const hasPend = dpGet(pendKey, null) !== null;
  const pendVal = hasPend ? dpGet(pendKey, null) : null;
  const regBal  = isGem ? (reg[target.id]?.gem ?? 0) : (reg[target.id]?.coin ?? 0);
  const curBal  = pendVal !== null ? pendVal : regBal;

  const form = new ActionFormData()
    .title(`§l  ${isGem ? "Gem" : "Koin"} — ${target.name} §7(Offline)  §r`)
    .body(
      `${HR}\n§7○ §f${target.name}  ${isGem ? "§b" : "§e"}${curBal} ${currency}` +
      (hasPend ? `\n§e⚠ Ada perubahan pending (belum login): §f${pendVal}` : "") +
      `\n${HR}\n§7Perubahan diterapkan saat player login.\n${HR}`
    )
    .button("§l Tambah").button("§l Kurangi").button("§l Set Nilai").button("§l Kembali");
  const res = await form.show(adminPlayer);
  if (res.canceled || res.selection === 3) return false;

  const action = ["add","remove","set"][res.selection];
  const actLbl = action === "add" ? "Tambah" : action === "remove" ? "Kurangi" : "Set";
  const inputRes = await new ModalFormData()
    .title(`§l  ${actLbl} ${isGem ? "Gem" : "Koin"} — ${target.name} (Offline)`)
    .textField(`§f${actLbl} §7(sekarang: §f${curBal}§7)`, "Contoh: 100", "0")
    .show(adminPlayer);
  if (inputRes.canceled) return false;

  const amount = Math.floor(Number(String(inputRes.formValues?.[0] ?? "0").trim()));
  if (!Number.isFinite(amount) || amount < 0) { adminPlayer.sendMessage("§c[!] Angka tidak valid."); return false; }

  let newBal;
  if      (action === "add")    newBal = curBal + amount;
  else if (action === "remove") newBal = Math.max(0, curBal - amount);
  else                          newBal = amount;

  dpSet(pendKey, newBal);

  try {
    const freshReg = getPlayerReg();
    if (freshReg[target.id]) {
      if (isGem) freshReg[target.id].gem = newBal;
      else       freshReg[target.id].coin = newBal;
      setPlayerReg(freshReg);
    }
  } catch (e) { console.warn("[Gacha] showAdminActionOffline registry update:", e); }

  adminPlayer.sendMessage(
    `§a[Admin] ${actLbl} §f${amount} ${currency} -> §7○§f${target.name}§f. Baru: §e${newBal}\n§7(Diterapkan saat login berikutnya)`
  );
  sfx(adminPlayer, SFX.ADMIN);
  return true;
}

async function showAdminCreateCode(adminPlayer) {
  const res = await new ModalFormData().title("§l§a  Buat Kode Diskon  §r")
    .textField("§fNama Kode §7(A-Z, 0-9, _ | 3-20 karakter)", "Contoh: HEMAT50", "")
    .slider("§fDiskon (%)", 5, 90, 5, 50)
    .dropdown("§fBerlaku untuk", ["Semua Gacha", "Partikel Saja", "Peralatan Saja"], 0)
    .slider("§fJumlah Pakai", 1, 50, 1, 1).show(adminPlayer);
  if (res.canceled) return;
  const [rawCode, discPct, typeIdx, uses] = res.formValues ?? [];
  const code = String(rawCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!code || code.length < 3 || code.length > 20) { adminPlayer.sendMessage("§c[!] Nama kode tidak valid."); return; }
  const map = getDiscCodes();
  if (map[code]) { adminPlayer.sendMessage(`§c[!] Kode §f"${code}"§c sudah ada.`); return; }
  const typeMap = ["ALL","PT","EQ"], typeLbl = ["Semua","Partikel","Peralatan"];
  map[code] = { pct: discPct, type: typeMap[typeIdx ?? 0], uses: uses ?? 1 };
  saveDiscCodes(map);
  adminPlayer.sendMessage(`§a[Admin] Kode §f${code} §adibuat! Diskon §f${discPct}% §a| §f${typeLbl[typeIdx ?? 0]} §a| §f${uses}x`);
  sfx(adminPlayer, SFX.ADMIN);
}

async function showAdminDeleteCode(adminPlayer) {
  const map = getDiscCodes(), codes = Object.keys(map);
  if (!codes.length) { adminPlayer.sendMessage("§7Tidak ada kode aktif."); return; }
  const typeLblMap = { ALL:"Semua", PT:"Partikel", EQ:"Peralatan" };
  const form = new ActionFormData().title("§l§c  Hapus Kode  §r").body(`${HR}\n§7 Pilih kode:\n${HR}`);
  for (const code of codes) { const e = map[code]; form.button(`§l ${code}\n§f${e.pct}% | ${typeLblMap[e.type]??e.type} | §e${e.uses}x`); }
  form.button("§l Kembali");
  const res = await form.show(adminPlayer);
  if (res.canceled || res.selection === codes.length) return;
  const targetCode = codes[res.selection];
  const confirm = await new MessageFormData().title("§l  Konfirmasi  §r")
    .body(`§f Hapus kode §c${targetCode}§f?`)
    .button1("§7  Batal").button2("§c  Ya, Hapus").show(adminPlayer);
  if (!confirm.canceled && confirm.selection === 1) {
    const fresh = getDiscCodes(); delete fresh[targetCode]; saveDiscCodes(fresh);
    adminPlayer.sendMessage(`§a[Admin] Kode §f${targetCode} §adihapus.`);
    sfx(adminPlayer, SFX.ADMIN);
  }
}

async function showAdminListCodes(adminPlayer) {
  const map = getDiscCodes(), codes = Object.keys(map);
  const typeLblMap = { ALL:"Semua Gacha", PT:"Partikel", EQ:"Peralatan" };
  let body = `${HR}\n§7 Kode aktif: §f${codes.length}\n${HR}\n`;
  if (!codes.length) body += "\n§7 (Tidak ada kode aktif)\n";
  else for (const code of codes) { const e = map[code]; body += `\n§f ${code}  §a${e.pct}%  §7${typeLblMap[e.type]??e.type}  §e${e.uses}x\n`; }
  await new ActionFormData().title("§l  Daftar Kode  §r").body(body).button("§l Kembali").show(adminPlayer);
}

async function showAdminRegisterChest(adminPlayer, block = null) {
  if (!adminPlayer.hasTag(CFG.ADMIN_TAG)) { adminPlayer.sendMessage("§c[!] Akses ditolak."); return; }

  if (!block) {
    await new ActionFormData()
      .title("§l  Daftarkan Chest  §r")
      .body(
        `${HR}\n§e Cara mendaftarkan chest:\n\n` +
        `§7Pegang §fAmethyst Shard §7lalu §aklik langsung §7ke chest\n§7yang ingin didaftarkan.\n\n` +
        `§7Pastikan chest berdiri di atas:\n` +
        `§7• §5Amethyst Block §7→ Gacha Partikel\n` +
        `§7• §cCrying Obsidian §7→ Gacha Peralatan\n` +
        `§7• Bukan double chest\n${HR}`
      )
      .button("§l Oke").show(adminPlayer);
    return;
  }

  const key          = ck(block);
  const type         = getChestType(block);
  const { x, y, z } = block.location;
  const dimId        = block.dimension.id;
  const typeLbl      = type === "PARTICLE" ? "§5Partikel" : "§6Peralatan";
  const allowed      = getAllowedChests();

  if (allowed.some(c => c.key === key)) {
    await new ActionFormData()
      .title("§l  Daftarkan Chest  §r")
      .body(`${HR}\n§e Chest ini sudah terdaftar!\n§f ${typeLbl}§f @ ${x}, ${y}, ${z}\n${HR}`)
      .button("§l Oke").show(adminPlayer);
    return;
  }

  const inputRes = await new ModalFormData()
    .title("§l  Daftarkan Chest  §r")
    .textField(
      `§f Chest ditemukan: ${typeLbl}\n§7 Posisi: §f${x}, ${y}, ${z}\n§7 Label (opsional):`,
      "Contoh: Chest Spawn", ""
    ).show(adminPlayer);
  if (inputRes.canceled) return;

  const label = String(inputRes.formValues?.[0] ?? "").trim() || `${type} @ ${x},${y},${z}`;
  allowed.push({ key, x, y, z, dimId, type, label });
  saveAllowedChests(allowed);
  startIdleForChest(key, dimId, { x, y, z }, type);

  adminPlayer.sendMessage(
    `§a[Admin] ✔ Chest terdaftar!\n` +
    `§7 Tipe  : ${typeLbl}\n` +
    `§7 Posisi: §f${x}, ${y}, ${z}\n` +
    `§7 Label : §f${label}`
  );
  sfx(adminPlayer, SFX.ADMIN);
}

async function showAdminManageChests(adminPlayer) {
  if (!adminPlayer.hasTag(CFG.ADMIN_TAG)) { adminPlayer.sendMessage("§c[!] Akses ditolak."); return; }

  while (true) {
    const allowed = getAllowedChests();
    if (!allowed.length) {
      await new ActionFormData()
        .title("§l  Kelola Chest  §r")
        .body(`${HR}\n§7 Belum ada chest yang terdaftar.\n${HR}`)
        .button("§l Kembali").show(adminPlayer);
      return;
    }

    const ptCount = allowed.filter(c => c.type === "PARTICLE").length;
    const eqCount = allowed.filter(c => c.type === "EQUIPMENT").length;
    const form = new ActionFormData()
      .title("§l  Kelola Chest Terdaftar  §r")
      .body(
        `${HR}\n§fTotal: §a${allowed.length} chest\n` +
        `§5Partikel: §f${ptCount}  §6Peralatan: §f${eqCount}\n` +
        `${HR}\n§7Pilih chest untuk menghapusnya:\n${HR}`
      );

    for (const c of allowed) {
      const typeLbl = c.type === "PARTICLE" ? "§5[PT]" : "§6[EQ]";
      const inUse   = activeChests.has(c.key) ? " §c[AKTIF]" : "";
      form.button(`${typeLbl} §f${c.label}${inUse}\n§7${c.x}, ${c.y}, ${c.z}`);
    }
    form.button("§l Kembali");

    sfx(adminPlayer, SFX.ADMIN);
    const res = await form.show(adminPlayer);
    if (res.canceled || res.selection === allowed.length) return;

    const target  = allowed[res.selection];
    const typeLbl = target.type === "PARTICLE" ? "§5Partikel" : "§6Peralatan";

    if (activeChests.has(target.key)) {
      adminPlayer.sendMessage("§c[!] Chest sedang aktif digunakan, tidak bisa dihapus sekarang.");
      continue;
    }

    const confirm = await new MessageFormData()
      .title("§l  Hapus Chest?  §r")
      .body(
        `§f Hapus chest dari whitelist?\n\n` +
        `${typeLbl}§f — ${target.label}\n§7${target.x}, ${target.y}, ${target.z}\n\n` +
        `§c⚠ Chest ini tidak bisa dipakai gacha setelah dihapus.`
      )
      .button1("§7 Batal").button2("§c Ya, Hapus").show(adminPlayer);

    if (!confirm.canceled && confirm.selection === 1) {
      const fresh = getAllowedChests().filter(c => c.key !== target.key);
      saveAllowedChests(fresh);
      stopIdleForChest(target.key);
      dpDel("gacha:chest_snap:" + target.key);
      dpDel("gacha:chest_lock:" + target.key);
      adminPlayer.sendMessage(
        `§a[Admin] Chest dihapus dari whitelist.\n§7${target.label} @ ${target.x}, ${target.y}, ${target.z}`
      );
      sfx(adminPlayer, SFX.ADMIN);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// EXPORT / IMPORT UI
// ═══════════════════════════════════════════════════════════
async function showExportImportAllUI(adminPlayer) {
  if (!adminPlayer.hasTag(CFG.ADMIN_TAG)) { adminPlayer.sendMessage("§c[!] Akses ditolak."); return; }
  while (true) {
    const pendingCount = (() => {
      const reg = getPlayerReg();
      return Object.keys(reg).filter(id => dpGet(CFG.K_IMPORT_PEND + id, null) !== null).length;
    })();

    const stagedImport    = dpGet(K_STAGED_IMPORT, null);
    const hasStagedImport = stagedImport !== null;

    const form = new ActionFormData().title("§l§3  Export / Import  §r")
      .body(
        `${HR}\n§7Format: §fGSALL5  §7(hanya player dengan Gem atau Partikel)\n` +
        (pendingCount ? `§e⚠ ${pendingCount} player menunggu pending import\n` : "") +
        (hasStagedImport
          ? `§b⚡ Data import siap — §f${stagedImport.count ?? "?"} player · oleh §a${stagedImport.stagedBy ?? "?"}\n`
          : `§7Belum ada data import yang disiapkan\n`) +
        HR
      )
      .button("§l Export Data")
      .button(hasStagedImport ? "§l§c Import Data §e[SIAP ⚡]" : "§l Import Data")
      .button("§l Pending Import")
      .button(hasStagedImport ? "§l§7 Hapus Data Staged" : "§8 Hapus Data Staged")
      .button("§l Kembali");

    sfx(adminPlayer, SFX.ADMIN);
    const res = await form.show(adminPlayer);
    if (res.canceled || res.selection === 4) return;
    if      (res.selection === 0) await showBulkExportUI(adminPlayer);
    else if (res.selection === 1) await showBulkImportUI(adminPlayer);
    else if (res.selection === 2) await showPendingImportList(adminPlayer);
    else if (res.selection === 3) {
      if (!hasStagedImport) { adminPlayer.sendMessage("§7Tidak ada data staged untuk dihapus."); continue; }
      const confirm = await new MessageFormData()
        .title("§l  Hapus Data Staged?  §r")
        .body(`§f Hapus data import yang sedang disiapkan?\n§7Data ini tidak akan diterapkan.`)
        .button1("§7 Batal").button2("§c Ya, Hapus").show(adminPlayer);
      if (!confirm.canceled && confirm.selection === 1) {
        dpDel(K_STAGED_IMPORT);
        adminPlayer.sendMessage("§a[Admin] Data staged dihapus.");
        sfx(adminPlayer, SFX.ADMIN);
      }
    }
  }
}

async function showBulkExportUI(adminPlayer) {
  if (!adminPlayer.hasTag(CFG.ADMIN_TAG)) { adminPlayer.sendMessage("§c[!] Akses ditolak."); return; }
  const { entries, full } = buildBulkExport();
  logBulkToConsole({ entries, full });

  if (!entries.length) {
    await new ActionFormData().title("§l§3  Export Data  §r")
      .body(`${HR}\n§7Belum ada player dengan Gem atau Partikel.\n${HR}`)
      .button("§l Kembali").show(adminPlayer);
    return;
  }

  await new ModalFormData()
    .title(`§l§3  Export Data — ${entries.length} player  §r`)
    .textField(
      `§eSalin seluruh string di bawah ini:\n§7${entries.length} player · ${full.length} karakter`,
      "", full
    )
    .show(adminPlayer);
}

// [FITUR BARU] Import membaca dari staged DP (di-set via gacha:prepare_import),
// bukan lagi dari text field. Admin wajib staging dulu sebelum bisa konfirmasi.
async function showBulkImportUI(adminPlayer) {
  if (!adminPlayer.hasTag(CFG.ADMIN_TAG)) { adminPlayer.sendMessage("§c[!] Akses ditolak."); return; }

  const staged = dpGet(K_STAGED_IMPORT, null);

  // Belum ada data staged — tampilkan instruksi cara staging
  if (!staged) {
    await new ActionFormData()
      .title("§l§6  Import Data  §r")
      .body(
        `${HR}\n§e⚠ Belum ada data import yang disiapkan.\n\n` +
        `§fCara menyiapkan data import:\n\n` +
        `§71. Lakukan Export terlebih dahulu\n` +
        `§72. Copy seluruh string export (GSALL5|...)\n` +
        `§73. Jalankan perintah berikut di chat atau console:\n\n` +
        `§f/scriptevent gacha:prepare_import §bGSALL5|...\n\n` +
        `§74. Kembali ke menu ini untuk konfirmasi\n\n` +
        `§8Catatan: data tidak langsung diterapkan.\n` +
        `§8Konfirmasi dilakukan dari UI ini.\n` +
        `${HR}`
      )
      .button("§l Mengerti").show(adminPlayer);
    return;
  }

  // Validasi string staged
  const parsed = parseBulkImport(staged.str ?? "");
  if (!parsed.ok) {
    await new ActionFormData()
      .title("§l§c  Import Data — Data Tidak Valid  §r")
      .body(
        `${HR}\n§cData yang di-stage tidak valid:\n§f${parsed.err}\n\n` +
        `§7Hapus data ini dan ulangi dengan:\n` +
        `§f/scriptevent gacha:prepare_import §bGSALL5|...\n${HR}`
      )
      .button("§l Hapus & Kembali").show(adminPlayer);
    dpDel(K_STAGED_IMPORT);
    return;
  }

  const { items } = parsed;
  const stagedBy  = staged.stagedBy ?? "tidak diketahui";
  const stagedAt  = staged.stagedAt
    ? new Date(staged.stagedAt).toLocaleString("id-ID", { hour12: false })
    : "tidak diketahui";

  // Langkah 1: Tampilkan info + peringatan bahaya
  const step1 = await new ActionFormData()
    .title("§l§6  Konfirmasi Import — Periksa Data  §r")
    .body(
      `${HR}\n§e★ Data Import Tersedia:\n` +
      `§f • Jumlah player  : §a${items.length}\n` +
      `§f • Disiapkan oleh : §a${stagedBy}\n` +
      `§f • Waktu staging  : §7${stagedAt}\n` +
      `${HR}\n` +
      `§4§l⚠⚠  PERINGATAN BAHAYA  ⚠⚠§r\n\n` +
      `§cOperasi ini akan MENIMPA data permanen:\n\n` +
      `§f  • §cGem §fsemua player dalam string\n` +
      `§f  • §cKoleksi partikel §fsemua player\n` +
      `§f  • §cPity counter §fequipment semua player\n\n` +
      `§c§lData yang ditimpa TIDAK BISA dipulihkan!\n§r\n` +
      `§e• Player online → langsung terpengaruh\n` +
      `§e• Player offline → terpengaruh saat login\n\n` +
      `§7Pastikan kamu sudah backup data sebelum lanjut.\n` +
      `§7Gunakan fitur Export untuk backup terlebih dahulu.\n` +
      `${HR}`
    )
    .button("§7 Batal, Kembali")
    .button("§c Saya mengerti risikonya — Lanjut")
    .show(adminPlayer);

  if (step1.canceled || step1.selection !== 1) return;

  // Langkah 2: Konfirmasi akhir — MessageFormData (2 tombol, tidak bisa dismiss)
  const step2 = await new MessageFormData()
    .title("§l§4  !! KONFIRMASI AKHIR !!  §r")
    .body(
      `§4§l⚠ TINDAKAN TIDAK BISA DI-UNDO! ⚠§r\n\n` +
      `§fData §a${items.length} player §fakan ditimpa sekarang.\n\n` +
      `§eApakah kamu benar-benar yakin ingin melanjutkan?`
    )
    .button1("§7  Tidak, Batalkan")
    .button2("§4  Ya, Terapkan Sekarang")
    .show(adminPlayer);

  if (step2.canceled || step2.selection !== 1) {
    adminPlayer.sendMessage("§7[Import] Dibatalkan.");
    return;
  }

  // Terapkan import
  adminPlayer.sendMessage("§e[Gacha] Menerapkan import, mohon tunggu...");
  const stats = applyBulkAll(items);
  dpDel(K_STAGED_IMPORT);
  sfx(adminPlayer, SFX.ADMIN);

  const notFoundInfo = stats.notFoundNames.length
    ? `\n§c   (${stats.notFoundNames.slice(0, 5).join(", ")}${stats.notFoundNames.length > 5 ? "..." : ""})`
    : "";
  adminPlayer.sendMessage(
    `§a[★] Import Selesai!\n` +
    `§7 Online  (langsung) : §a${stats.applied}\n` +
    `§7 Offline (pending)  : §e${stats.pending}\n` +
    `§7 Tidak ditemukan    : §c${stats.notFound}${notFoundInfo}`
  );
}

async function showPendingImportList(adminPlayer) {
  const reg     = getPlayerReg();
  const pending = Object.entries(reg)
    .filter(([id]) => dpGet(CFG.K_IMPORT_PEND + id, null) !== null)
    .map(([id, info]) => ({ id, name: info.name }));

  if (!pending.length) {
    await new ActionFormData().title("§l  Pending Import  §r")
      .body(`${HR}\n§7 Tidak ada pending import aktif.\n${HR}`)
      .button("§l Kembali").show(adminPlayer);
    return;
  }

  let body = `${HR}\n§e${pending.length} player menunggu import:\n${HR}\n`;
  for (const e of pending) {
    const p = dpGet(CFG.K_IMPORT_PEND + e.id, {});
    body += `§7○ §f${e.name}  §7Gem:${p.gem ?? "?"}  PT:${(p.particles ?? []).length}\n`;
  }
  body += HR;

  const form = new ActionFormData().title("§l  Pending Import  §r").body(body);
  for (const e of pending) form.button(`§l Batalkan: §f${e.name}`);
  form.button("§l Kembali");

  const res = await form.show(adminPlayer);
  if (res.canceled || res.selection === pending.length) return;

  const target  = pending[res.selection];
  const confirm = await new MessageFormData().title("§l  Batalkan Pending?  §r")
    .body(`§f Batalkan pending import untuk §c${target.name}§f?`)
    .button1("§7 Tidak").button2("§c Ya, Batalkan").show(adminPlayer);
  if (!confirm.canceled && confirm.selection === 1) {
    dpDel(CFG.K_IMPORT_PEND + target.id);
    adminPlayer.sendMessage(`§a[Admin] Pending import §f${target.name}§a dibatalkan.`);
    sfx(adminPlayer, SFX.ADMIN);
  }
}

// ═══════════════════════════════════════════════════════════
// ACTION BAR
// ═══════════════════════════════════════════════════════════
const _triggerHolders = new Set();

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    const held      = player.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)?.typeId ?? "";
    const isHolding  = held === CFG.TRIGGER;
    const wasHolding = _triggerHolders.has(player.id);

    if (!isHolding) {
      if (wasHolding) {
        _triggerHolders.delete(player.id);
        chestCache.delete(player.id);
        lastActionBar.delete(player.id);
      }
      continue;
    }

    if (!wasHolding) {
      _triggerHolders.add(player.id);
      const near = nearbyValidChestCached(player);
      let msg;
      if (!near) {
        msg = `§7Cari Chest  §8|  §5Amethyst §7(PT)  §8|  §cCrying Obs §7(EQ)  §8|  §eKlik kanan §7-> Hub`;
      } else {
        const ctype = getChestType(near);
        if (activeChests.has(ck(near)))  msg = `§c[!] Chest sedang digunakan...`;
        else if (ctype === "PARTICLE")   msg = `§5[PARTIKEL] §bKlik  §71x:§b${CFG.PT_COST_1}G  §710x:§b${CFG.PT_COST_10}G`;
        else                             msg = `§6[PERALATAN] §eKlik  §71x:§e${CFG.EQ_COST_1}K  §710x:§e${CFG.EQ_COST_10}K`;
      }
      lastActionBar.set(player.id, { msg, tick: system.currentTick });
      try { player.onScreenDisplay.setActionBar(msg); } catch {}
    }
  }
}, CFG.ACTIONBAR_INT);

// ═══════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════
world.afterEvents.worldInitialize.subscribe(() => {
  if (!world.scoreboard.getObjective(CFG.GEM_OBJ))  world.scoreboard.addObjective(CFG.GEM_OBJ, "Gem");
  if (!world.scoreboard.getObjective(CFG.COIN_OBJ)) world.scoreboard.addObjective(CFG.COIN_OBJ, "Koin");

  initSecurity(
    mkItem,
    (dimId) => world.getDimension(dimId),
  );

  registerItemDropGuard();

  system.runTimeout(() => {
    for (const c of getAllowedChests()) {
      startIdleForChest(c.key, c.dimId, { x: c.x, y: c.y, z: c.z }, c.type);
    }
  }, 20);
});

world.afterEvents.playerPlaceBlock.subscribe(ev => {
  const { block } = ev;
  if (block.typeId !== "minecraft:chest") return;
  system.runTimeout(() => {
    try {
      if (!isChestCandidate(block)) return;
      const key = ck(block);
      const reg = getAllowedChests().find(c => c.key === key);
      if (reg) startIdleForChest(reg.key, reg.dimId, { x: reg.x, y: reg.y, z: reg.z }, reg.type);
    } catch {}
  }, 5);
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) {
    const tagGem = tGet(player, T.GEM, -1);
    if (tagGem >= 0) setScore(CFG.GEM_OBJ, player, tagGem);
    else setGem(player, 0);

    const existingCoin = getCoin(player);
    setScore(CFG.COIN_OBJ, player, existingCoin);
  }

  system.runTimeout(() => {
    const live = world.getPlayers().find(p => p.id === player.id);
    if (!live) return;

    // [FIX RESTART] Cek pessimistic refund — sisa sesi gacha yang terputus
    // saat server restart. Cost dikembalikan otomatis sebelum cek pending lain.
    const sessRef = dpGet(K_SESS_REF + live.id, null);
    if (sessRef) {
      try {
        const refCost = sessRef.cost ?? 0;
        const refType = sessRef.type ?? "PARTICLE";
        if (refCost > 0) {
          if (refType === "PARTICLE") setGem(live, getGem(live) + refCost);
          else setScore(CFG.COIN_OBJ, live, getCoin(live) + refCost);
          live.sendMessage(
            `§a[+] ${refCost} ${refType === "PARTICLE" ? "Gem" : "Koin"} dikembalikan otomatis.\n` +
            `§7(Sesi gacha terputus saat server restart)`
          );
          sfx(live, SFX.CLAIM);
        }
      } catch (e) { console.warn("[Gacha] sessRef recovery error:", e); }
      dpDel(K_SESS_REF + live.id);
    }

    const pendGem = dpGet(K_PEND_GEM + live.id, null);
    if (pendGem !== null) {
      try { setGem(live, pendGem); dpDel(K_PEND_GEM + live.id); live.sendMessage(`§a[+] Gem diperbarui oleh admin: §b${pendGem}`); } catch {}
    }
    const pendCoin = dpGet(K_PEND_COIN + live.id, null);
    if (pendCoin !== null) {
      try { setScore(CFG.COIN_OBJ, live, pendCoin); dpDel(K_PEND_COIN + live.id); live.sendMessage(`§a[+] Koin diperbarui oleh admin: §e${pendCoin}`); } catch {}
    }

    const pending = applyPendingImport(live);
    if (pending) {
      sfx(live, SFX.CLAIM);
      live.sendMessage(
        `§a[★] Import offline diterapkan!\n` +
        `§7Gem: §b${pending.gem}§7  Partikel: §e${pending.particles.length}§7  EqPity: §e${pending.eqsr}/${pending.eql}`
      );
    }
  }, 100);
  system.runTimeout(() => syncPlayerData(player), 120);

  if (!initialSpawn) return;
  system.runTimeout(() => {
    const list = getPend(player); if (!list.length) return;
    const n = claimPend(player), rem = getPend(player).length;
    if (n > 0) {
      sfx(player, SFX.CLAIM);
      player.sendMessage(`§a[+] ${n} item pending diklaim saat login!${rem ? `\n§e${rem} item masih pending.` : ""}`);
    } else {
      player.sendMessage(`§e⚠ ${list.length} item pending (inv penuh).\n§7Pegang §bAmethyst Shard §7dan klik chest.`);
    }
  }, 60);
});

world.beforeEvents.playerBreakBlock.subscribe(event => {
  const { block, player } = event;

  if (block.typeId === "minecraft:chest") {
    const key = ck(block);
    if (activeChests.has(key) || dpGet("gacha:chest_lock:" + key, null)) {
      event.cancel = true;
      system.run(() => player.sendMessage("§c⚠ Chest gacha aktif tidak bisa dihancurkan!"));
      return;
    }
    if (isValidChest(block) && !player.hasTag(CFG.ADMIN_TAG)) {
      event.cancel = true;
      system.run(() => player.sendMessage("§c⚠ Chest gacha terdaftar tidak bisa dihancurkan!\n§7Minta admin untuk menghapus daftarnya terlebih dahulu."));
      return;
    }
  }

  const { x, y, z } = block.location;
  try {
    const above = block.dimension.getBlock({ x, y: y + 1, z });
    if (above?.typeId === "minecraft:chest" && isValidChest(above)) {
      event.cancel = true;
      system.run(() => player.sendMessage("§c⚠ Block ini menopang chest gacha terdaftar!"));
    }
  } catch {}
});

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  activePlayers.delete(playerId);
  lockSet.delete(playerId);
  lastPull.delete(playerId);
  pendingDisc.delete(playerId);
  chestCache.delete(playerId);
  lastActionBar.delete(playerId);
  pendingChestInteract.delete(playerId);
  _triggerHolders.delete(playerId);
  for (const [key, id] of activeChests)
    if (id === playerId) clearLock(key);
});

world.beforeEvents.playerLeave.subscribe(({ player }) => {
  try { syncPlayerData(player); } catch {}
});

world.afterEvents.itemUse.subscribe(ev => {
  const player = ev.source;
  if (ev.itemStack?.typeId !== CFG.TRIGGER) return;
  if (activePlayers.has(player.id) || pendingChestInteract.has(player.id)) return;
  if ((lastPull.get(player.id) ?? 0) + CFG.PULL_CD > system.currentTick) {
    player.sendMessage("§e[Gacha] Tunggu sebentar!"); return;
  }
  system.run(async () => {
    activePlayers.set(player.id, "__hub__");
    try {
      const claimed = claimPend(player);
      if (claimed > 0) { sfx(player, SFX.CLAIM); player.sendMessage(`§a[+] ${claimed} item diklaim otomatis.`); }
      await showHubMenu(player);
    } catch (err) { console.error("[Gacha] Hub error:", err); }
    finally { activePlayers.delete(player.id); }
  });
});

registerSecureChestHandler(
  getChestType,
  isChestCandidate,
  isValidChest,
  showAdminRegisterChest,
  startGacha,
  {
    activePlayers,
    pendingChestInteract,
    lastPull,
    SFX,
    sfx,
  }
);

// ═══════════════════════════════════════════════════════════
// SCRIPT EVENT LISTENERS
// ═══════════════════════════════════════════════════════════
system.afterEvents.scriptEventReceive.subscribe(ev => {
  const src = ev.sourceEntity;
  const isAdmin = !src || (typeof src.hasTag === "function" && src.hasTag(CFG.ADMIN_TAG));

  // ── gacha:bulk_export ──────────────────────────────────────
  if (ev.id === "gacha:bulk_export") {
    if (!isAdmin) { src?.sendMessage?.("§c[!] Akses ditolak. Butuh tag: " + CFG.ADMIN_TAG); return; }
    try {
      const result = buildBulkExport();
      logBulkToConsole(result);
      src?.sendMessage?.(
        `§a[GachaBulk] Export selesai!\n§7 Total player: §f${result.entries.length}\n` +
        `§7 Panjang str : §f${result.full.length} char\n§eString sudah dicetak di console server.`
      );
    } catch (err) { console.error("[GachaBulk] export error:", err); }
    return;
  }

  // ── gacha:prepare_import ───────────────────────────────────
  // Menyimpan string import ke DP sebagai staged data.
  // Admin harus konfirmasi lewat UI sebelum import diterapkan.
  // Cara pakai: /scriptevent gacha:prepare_import GSALL5|N|...
  if (ev.id === "gacha:prepare_import") {
    if (!isAdmin) { src?.sendMessage?.("§c[!] Akses ditolak. Butuh tag: " + CFG.ADMIN_TAG); return; }
    const raw = (ev.message ?? "").trim();
    if (!raw) {
      src?.sendMessage?.(
        `§c[!] String kosong.\n` +
        `§7Cara: §f/scriptevent gacha:prepare_import §bGSALL5|N|...`
      );
      return;
    }
    const parsed = parseBulkImport(raw);
    if (!parsed.ok) {
      src?.sendMessage?.(`§c[!] String tidak valid: §f${parsed.err}`);
      return;
    }
    const senderName = (src && typeof src.name === "string") ? src.name : "Console";
    dpSet(K_STAGED_IMPORT, {
      str:      raw,
      stagedBy: senderName,
      stagedAt: Date.now(),
      count:    parsed.items.length,
    });
    src?.sendMessage?.(
      `§a[✔] Data import disiapkan!\n` +
      `§7 Player   : §f${parsed.items.length}\n` +
      `§7 Konfirmasi: §eAdmin Panel → Export/Import → Import Data`
    );
    return;
  }

  // ── gacha:clear_staged ─────────────────────────────────────
  // Membatalkan/menghapus data staged yang belum dikonfirmasi.
  // Cara pakai: /scriptevent gacha:clear_staged
  if (ev.id === "gacha:clear_staged") {
    if (!isAdmin) { src?.sendMessage?.("§c[!] Akses ditolak. Butuh tag: " + CFG.ADMIN_TAG); return; }
    const existing = dpGet(K_STAGED_IMPORT, null);
    if (!existing) { src?.sendMessage?.("§7Tidak ada data staged."); return; }
    dpDel(K_STAGED_IMPORT);
    src?.sendMessage?.("§a[✔] Data staged dihapus. Import dibatalkan.");
    return;
  }

  // ── gacha:bulk_import ──────────────────────────────────────
  // Import langsung tanpa konfirmasi UI (untuk penggunaan console/server admin).
  // Untuk keamanan lebih, gunakan gacha:prepare_import + UI.
  if (ev.id === "gacha:bulk_import") {
    if (!isAdmin) { src?.sendMessage?.("§c[!] Akses ditolak. Butuh tag: " + CFG.ADMIN_TAG); return; }
    const raw = (ev.message ?? "").trim();
    if (!raw) {
      src?.sendMessage?.("§c[!] String kosong.\n§7Cara: §f/scriptevent gacha:bulk_import GSALL5|N|...");
      return;
    }
    const parsed = parseBulkImport(raw);
    if (!parsed.ok) { src?.sendMessage?.(`§c[!] Parse gagal: ${parsed.err}`); return; }
    try {
      const stats = applyBulkAll(parsed.items);
      console.warn(
        `[GachaBulk] bulk_import via scriptevent: ${parsed.items.length} entries -> ` +
        `applied:${stats.applied} pending:${stats.pending} notFound:${stats.notFound}` +
        (stats.notFoundNames.length ? ` [${stats.notFoundNames.join(",")}]` : "")
      );
      src?.sendMessage?.(
        `§a[★] Bulk Import selesai!\n§7 Online  (langsung): §a${stats.applied}\n` +
        `§7 Offline (pending) : §e${stats.pending}\n§7 Tdk ditemukan     : §c${stats.notFound}`
      );
    } catch (err) { src?.sendMessage?.("§c[!] Error: " + err); }
  }
});
