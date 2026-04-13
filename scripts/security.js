import { world, system } from "@minecraft/server";
import {
  CFG, MARK, activeChests, chestExpected,
  ck, isMark,
} from "./config.js";
import { dpGet, dpSet, dpDel } from "./data.js";

const K_REG_CHESTS    = "gacha:reg_chests";
const K_CHEST_LOCK    = "gacha:chest_lock:";
const K_CHEST_SNAP    = "gacha:chest_snap:";

const GLOBAL_GUARD_INT   = 10;
const INV_SCAN_INT       = 10;
const LOCK_EXPIRE_MS     = 5 * 60 * 1000;

function getAllowedChests() { return dpGet(K_REG_CHESTS, []); }

let _mkItem = null;

export function persistLock(chestKey, ownerId) {
  dpSet(K_CHEST_LOCK + chestKey, {
    ownerId,
    time: Date.now(),
  });
}

export function clearLock(chestKey) {
  dpDel(K_CHEST_LOCK + chestKey);
  activeChests.delete(chestKey);
  chestExpected.delete(chestKey);
}

export function isSessionOwner(chestKey, playerId) {
  if (activeChests.get(chestKey) === playerId) return true;
  const lock = dpGet(K_CHEST_LOCK + chestKey, null);
  return lock !== null && lock.ownerId === playerId;
}

export function loadChestSnapshot(chestKey) {
  return dpGet(K_CHEST_SNAP + chestKey, null);
}

function restoreChestFromSnapshot(container, chestKey, mkItemFn) {
  const snap = loadChestSnapshot(chestKey);
  if (!snap) return false;
  try {
    for (let i = 0; i < 27; i++) {
      if (!snap[i]) { container.setItem(i, undefined); continue; }
      const actual = container.getItem(i);
      if (
        !actual ||
        actual.typeId  !== snap[i].typeId ||
        actual.nameTag !== snap[i].nameTag
      ) {
        container.setItem(i, mkItemFn(snap[i].typeId, snap[i].nameTag.replace(MARK, "")));
      }
    }
    return true;
  } catch {
    return false;
  }
}

function scanAllPlayerInventories() {
  for (const p of world.getPlayers()) {
    try {
      const inv = p.getComponent("minecraft:inventory")?.container;
      if (!inv) continue;
      let found = false;
      for (let s = 0; s < inv.size; s++) {
        if (isMark(inv.getItem(s))) {
          inv.setItem(s, undefined);
          found = true;
        }
      }
      if (found) p.sendMessage("§c⚠ Item gacha tidak dapat diambil!");
    } catch {}
  }
}

function cleanExpiredLocks() {
  const now = Date.now();
  const chests = getAllowedChests();
  for (const c of chests) {
    const lock = dpGet(K_CHEST_LOCK + c.key, null);
    if (!lock) continue;

    // Jangan hapus lock jika owner masih online — clearLock() memanggil
    // activeChests.delete() sehingga bisa memutus sesi aktif player.
    const ownerOnline = world.getPlayers().some(p => p.id === lock.ownerId);
    if (ownerOnline) continue;

    const lockTime = lock.time ?? null;
    if (lockTime === null || (now - lockTime) > LOCK_EXPIRE_MS) {
      console.warn(`[GachaSec] Lock kedaluwarsa dihapus: ${c.key} (owner: ${lock.ownerId})`);
      clearLock(c.key);
    }
  }
}

export function initSecurity(mkItemFn, getDimFn) {
  _mkItem = mkItemFn;

  const INV_SCAN_EVERY = Math.max(1, Math.round(INV_SCAN_INT / GLOBAL_GUARD_INT));
  let guardCtr = 0;

  system.runInterval(() => {
    guardCtr++;
    const chests = getAllowedChests();

    for (const c of chests) {
      if (activeChests.has(c.key)) continue;

      const staleLock = dpGet(K_CHEST_LOCK + c.key, null);
      if (staleLock) {
        const ownerOnline = world.getPlayers().some(p => p.id === staleLock.ownerId);
        if (ownerOnline) continue;
        console.warn(`[GachaSec] Membersihkan stale lock untuk chest ${c.key}`);
        clearLock(c.key);
      }

      try {
        const dim = getDimFn(c.dimId);
        const block = dim.getBlock({ x: c.x, y: c.y, z: c.z });
        if (block?.typeId !== "minecraft:chest") continue;
        const container = block.getComponent("minecraft:inventory")?.container;
        if (!container) continue;
        restoreChestFromSnapshot(container, c.key, mkItemFn);
      } catch {}
    }

    if (guardCtr % INV_SCAN_EVERY === 0) {
      scanAllPlayerInventories();
    }
  }, GLOBAL_GUARD_INT);

  system.runInterval(() => {
    cleanExpiredLocks();
  }, 200);

  console.warn("[GachaSec] Security module initialized.");
}

export function snapshotExpected(chestKey) {
  const exp = chestExpected.get(chestKey);
  if (!exp) return;
  const lean = exp.map(e => e ? { typeId: e.typeId, nameTag: e.nameTag } : null);
  dpSet(K_CHEST_SNAP + chestKey, lean);
}

export function registerSecureChestHandler(
  getChestTypeFn,
  isChestCandidateFn,
  isValidChestFn,
  showAdminRegFn,
  startGachaFn,
  stateRefs
) {
  const { activePlayers, pendingChestInteract, lastPull, SFX, sfx } = stateRefs;

  world.beforeEvents.playerInteractWithBlock.subscribe(event => {
    const { player, block } = event;
    if (block.typeId !== "minecraft:chest") return;

    const key = ck(block);
    const isRegistered = isValidChestFn(block);

    if (isRegistered) {
      const sessionOwner = activeChests.get(key) ?? dpGet(K_CHEST_LOCK + key, null)?.ownerId ?? null;

      if (sessionOwner && sessionOwner !== player.id) {
        event.cancel = true;
        system.run(() => player.sendMessage("§e[!] Chest sedang digunakan orang lain!"));
        return;
      }

      if (!sessionOwner) {
        event.cancel = true;
      }
    }

    const holdingTrigger = player.getComponent("minecraft:equippable")
      ?.getEquipment("Mainhand")?.typeId === CFG.TRIGGER;

    if (!holdingTrigger) return;

    if (!isChestCandidateFn(block)) {
      system.run(() => player.sendMessage(
        "§c[!] Bukan chest gacha!\n§7Chest harus di atas §5Amethyst Block §7(PT) atau §cCrying Obsidian §7(EQ)"
      ));
      return;
    }

    if (!isRegistered) {
      if (player.hasTag(CFG.ADMIN_TAG)) {
        if (activePlayers.has(player.id)) {
          system.run(() => player.sendMessage("§e[Gacha] Selesaikan sesi yang aktif dulu!"));
          return;
        }
        system.run(async () => {
          activePlayers.set(player.id, "__reg__");
          try { await showAdminRegFn(player, block); }
          catch (err) { console.error("[Gacha] Register chest error:", err); }
          finally { activePlayers.delete(player.id); }
        });
      } else {
        system.run(() => player.sendMessage(
          "§e[!] Chest ini belum terdaftar.\n§7Minta admin untuk mendaftarkan chest ini."
        ));
      }
      return;
    }

    const sessionOwner = activeChests.get(key) ?? dpGet(K_CHEST_LOCK + key, null)?.ownerId ?? null;
    if (sessionOwner && sessionOwner !== player.id) {
      system.run(() => player.sendMessage("§e[!] Chest sedang digunakan orang lain!"));
      return;
    }

    if (activePlayers.has(player.id)) {
      system.run(() => player.sendMessage("§e[Gacha] Selesaikan sesi yang aktif dulu!"));
      return;
    }

    if ((lastPull.get(player.id) ?? 0) + CFG.PULL_CD > system.currentTick) {
      system.run(() => player.sendMessage("§e[Gacha] Tunggu sebentar!"));
      return;
    }

    pendingChestInteract.add(player.id);
    const chestType = getChestTypeFn(block);
    system.run(async () => {
      pendingChestInteract.delete(player.id);
      activePlayers.set(player.id, key);
      try { await startGachaFn(player, block, chestType); }
      catch (err) { console.error("[Gacha] Fatal:", err); player.sendMessage("§c[Gacha] Error fatal."); }
      finally { activePlayers.delete(player.id); }
    });
  });
}

export function registerItemDropGuard() {
  world.afterEvents.entitySpawn.subscribe(ev => {
    try {
      const ent = ev.entity;
      if (ent.typeId !== "minecraft:item") return;
      const stack = ent.getComponent("minecraft:item")?.itemStack;
      if (!stack) return;

      if (stack.nameTag?.startsWith(MARK)) {
        ent.remove();
        return;
      }

      const entDimId = ent.dimension.id;
      const entLoc   = ent.location;
      const chests   = getAllowedChests();
      for (const c of chests) {
        if (c.dimId !== entDimId) continue;
        const dx = entLoc.x - c.x, dy = entLoc.y - c.y, dz = entLoc.z - c.z;
        if (dx*dx + dy*dy + dz*dz <= 4) {
          ent.remove();
          return;
        }
      }
    } catch {}
  });
}
