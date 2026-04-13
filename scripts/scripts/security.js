import { world, system } from "@minecraft/server";
import {
  CFG, MARK, activeChests, chestExpected,
  ck, isMark,
} from "./config.js";
import { dpGet, dpSet, dpDel } from "./data.js";

// ── Key persistent ────────────────────────────────────────
const K_REG_CHESTS    = "gacha:reg_chests";        // whitelist chest (sudah ada di main.js)
const K_CHEST_LOCK    = "gacha:chest_lock:";       // key per chest → { ownerId, time }
const K_CHEST_SNAP    = "gacha:chest_snap:";       // snapshot konten terakhir (idle frame)

// ── Interval config ───────────────────────────────────────
const GLOBAL_GUARD_INT   = 10;  // tick; scan semua chest terdaftar (dinaikkan dari 4 → hemat CPU)
const INV_SCAN_INT       = 10;  // tick; scan inventory semua player
const LOCK_EXPIRE_MS     = 5 * 60 * 1000; // 5 menit dalam ms (pakai Date.now, bukan currentTick)

// ── Helpers ───────────────────────────────────────────────
function getAllowedChests() { return dpGet(K_REG_CHESTS, []); }

/** Dipanggil sekali dari initSecurity, menyimpan referensi mkItem dari main.js */
let _mkItem = null;

// ═══════════════════════════════════════════════════════════
// 1. PERSISTENT SESSION LOCK
//    Menyimpan sesi aktif ke dynamic properties agar survive restart.
// ═══════════════════════════════════════════════════════════

/**
 * Simpan lock sesi ke DP.
 * @param {string} chestKey
 * @param {string} ownerId
 */
export function persistLock(chestKey, ownerId) {
  dpSet(K_CHEST_LOCK + chestKey, {
    ownerId,
    time: Date.now(), // pakai Date.now() agar survive server restart (system.currentTick reset ke 0)
  });
}

/**
 * Hapus lock sesi dari DP dan memory.
 * @param {string} chestKey
 */
export function clearLock(chestKey) {
  dpDel(K_CHEST_LOCK + chestKey);
  activeChests.delete(chestKey);
  chestExpected.delete(chestKey);
}

/**
 * Cek apakah player adalah pemilik sesi chest.
 * @param {string} chestKey
 * @param {string} playerId
 */
export function isSessionOwner(chestKey, playerId) {
  // Cek memory dulu (paling cepat)
  if (activeChests.get(chestKey) === playerId) return true;
  // Fallback ke DP (setelah restart)
  const lock = dpGet(K_CHEST_LOCK + chestKey, null);
  return lock !== null && lock.ownerId === playerId;
}

// ═══════════════════════════════════════════════════════════
// 2. SNAPSHOT KONTEN IDLE
//    Simpan "expected content" idle ke DP agar bisa dipulihkan
//    setelah restart tanpa harus menjalankan drawIdleFrame lagi.
// ═══════════════════════════════════════════════════════════

/**
 * Baca snapshot dari DP.
 * @param {string} chestKey
 * @returns {Array|null}
 */
export function loadChestSnapshot(chestKey) {
  return dpGet(K_CHEST_SNAP + chestKey, null);
}

// ═══════════════════════════════════════════════════════════
// 3. GLOBAL ANTI-THEFT INTERVAL
//    Berjalan setiap GLOBAL_GUARD_INT tick.
//    - Periksa semua chest terdaftar
//    - Pulihkan konten jika ada yang diubah di luar sesi aktif
//    - Scan inventory semua player dan hapus item bertanda
// ═══════════════════════════════════════════════════════════

/**
 * Paksa pulihkan semua slot chest ke snapshot idle yang tersimpan.
 * @param {object} container
 * @param {string} chestKey
 * @param {Function} mkItemFn   — mkItem(typeId, nameTag)
 */
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

/** Scan inventory semua player online, hapus item bertanda. */
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

/** Cleanup lock DP yang kedaluwarsa (sesi crash / disconnect). */
function cleanExpiredLocks() {
  const now = Date.now(); // Date.now() tidak reset saat server restart
  const chests = getAllowedChests();
  for (const c of chests) {
    const lock = dpGet(K_CHEST_LOCK + c.key, null);
    if (!lock) continue;
    // Backward-compat: lock lama memakai field 'tick', bukan 'time' → hapus langsung
    const lockTime = lock.time ?? null;
    if (lockTime === null || (now - lockTime) > LOCK_EXPIRE_MS) {
      console.warn(`[GachaSec] Lock kedaluwarsa dihapus: ${c.key} (owner: ${lock.ownerId})`);
      clearLock(c.key);
    }
  }
}

/**
 * Inisialisasi semua guard.
 * HARUS dipanggil dari worldInitialize SETELAH scoreboard siap.
 * @param {Function} mkItemFn     — fungsi mkItem dari main.js
 * @param {Function} getDimFn     — (dimId: string) => Dimension
 */
export function initSecurity(mkItemFn, getDimFn) {
  _mkItem = mkItemFn;

  // ── Global anti-theft: chest content guard + inventory scan ──────────
  // INV_SCAN_INT dan GLOBAL_GUARD_INT bisa berbeda, hitung berapa kali guard
  // harus jalan sebelum scan inventory. Gunakan Math.round agar selalu integer.
  const INV_SCAN_EVERY = Math.max(1, Math.round(INV_SCAN_INT / GLOBAL_GUARD_INT));
  let guardCtr = 0;

  system.runInterval(() => {
    guardCtr++;
    const chests = getAllowedChests();

    for (const c of chests) {
      // [FIX BUG-5] Cek DULU memory activeChests, lalu DP lock.
      // Jika salah satunya aktif dan owner masih online, SKIP sepenuhnya.
      // Ini mencegah global guard menulis ke container yang sedang dipakai
      // session guard (interval 2 tick di main.js), menghindari konflik tulis.
      if (activeChests.has(c.key)) continue;

      const staleLock = dpGet(K_CHEST_LOCK + c.key, null);
      if (staleLock) {
        const ownerOnline = world.getPlayers().some(p => p.id === staleLock.ownerId);
        if (ownerOnline) continue; // owner masih online, session guard yang handle
        // Owner offline = lock stale, bersihkan
        console.warn(`[GachaSec] Membersihkan stale lock untuk chest ${c.key}`);
        clearLock(c.key);
        // Setelah clear, lanjut ke restore snapshot di bawah
      }

      // Pulihkan konten chest ke snapshot idle
      try {
        const dim = getDimFn(c.dimId);
        const block = dim.getBlock({ x: c.x, y: c.y, z: c.z });
        if (block?.typeId !== "minecraft:chest") continue;
        const container = block.getComponent("minecraft:inventory")?.container;
        if (!container) continue;
        restoreChestFromSnapshot(container, c.key, mkItemFn);
      } catch {}
    }

    // Scan inventory player setiap INV_SCAN_EVERY iterasi (Bug #1 fix)
    if (guardCtr % INV_SCAN_EVERY === 0) {
      scanAllPlayerInventories();
    }
  }, GLOBAL_GUARD_INT);

  // ── Expired lock cleanup setiap 200 tick (~20 detik) ────
  system.runInterval(() => {
    cleanExpiredLocks();
  }, 200);

  console.warn("[GachaSec] Security module initialized.");
}

// ═══════════════════════════════════════════════════════════
// 4. HELPER: Simpan snapshot setelah drawIdleFrame selesai
//    Panggil ini dari main.js setiap kali drawIdleFrame dipanggil
//    dan kita sudah tahu konten chestExpected.
// ═══════════════════════════════════════════════════════════

/**
 * Salin chestExpected[key] ke DP snapshot.
 * Panggil ini dari drawIdleFrame / drawIdle setelah setSlot selesai.
 * @param {string} chestKey
 */
export function snapshotExpected(chestKey) {
  const exp = chestExpected.get(chestKey);
  if (!exp) return;
  // Simpan versi yang lean (hanya typeId + nameTag)
  const lean = exp.map(e => e ? { typeId: e.typeId, nameTag: e.nameTag } : null);
  dpSet(K_CHEST_SNAP + chestKey, lean);
}

// ═══════════════════════════════════════════════════════════
// 5. PATCH: beforeEvents.playerInteractWithBlock
//    Handler baru yang MENGGANTIKAN handler di main.js.
//    Blokir semua akses ke chest terdaftar oleh siapapun
//    yang bukan pemilik sesi aktif.
// ═══════════════════════════════════════════════════════════

/**
 * Daftarkan handler interaksi chest yang aman.
 * HARUS dipanggil SATU KALI, menggantikan handler lama.
 *
 * @param {Function} getChestTypeFn     — getChestType(block)
 * @param {Function} isChestCandidateFn — isChestCandidate(block)
 * @param {Function} isValidChestFn     — isValidChest(block)
 * @param {Function} showAdminRegFn     — showAdminRegisterChest(player, block)
 * @param {Function} startGachaFn       — startGacha(player, block, type)
 * @param {object}   stateRefs          — { activePlayers, pendingChestInteract, lastPull, SFX, sfx }
 */
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

    // ── BLOKIR: Semua interaksi ke chest terdaftar kecuali pemilik sesi ──
    if (isRegistered) {
      const sessionOwner = activeChests.get(key) ?? dpGet(K_CHEST_LOCK + key, null)?.ownerId ?? null;

      if (sessionOwner && sessionOwner !== player.id) {
        // Ada sesi aktif, player ini bukan pemiliknya
        event.cancel = true;
        system.run(() => player.sendMessage("§e[!] Chest sedang digunakan orang lain!"));
        return;
      }

      if (!sessionOwner) {
        // Tidak ada sesi → selalu batalkan buka chest secara manual
        event.cancel = true;
      }
    }

    // ── Lanjutkan logika trigger (Amethyst Shard) ─────────
    const holdingTrigger = player.getComponent("minecraft:equippable")
      ?.getEquipment("Mainhand")?.typeId === CFG.TRIGGER;

    if (!holdingTrigger) return; // event sudah di-cancel di atas, tidak ada yang perlu dilakukan

    // ── Bukan kandidat chest gacha ──────────────────────
    if (!isChestCandidateFn(block)) {
      system.run(() => player.sendMessage(
        "§c[!] Bukan chest gacha!\n§7Chest harus di atas §5Amethyst Block §7(PT) atau §cCrying Obsidian §7(EQ)"
      ));
      return;
    }

    // ── Belum terdaftar → admin bisa daftarkan ──────────
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

    // ── Guard: player lain sedang sesi ──────────────────
    const sessionOwner = activeChests.get(key) ?? dpGet(K_CHEST_LOCK + key, null)?.ownerId ?? null;
    if (sessionOwner && sessionOwner !== player.id) {
      system.run(() => player.sendMessage("§e[!] Chest sedang digunakan orang lain!"));
      return;
    }

    // ── Guard: player sendiri sedang sesi lain ───────────
    if (activePlayers.has(player.id)) {
      system.run(() => player.sendMessage("§e[Gacha] Selesaikan sesi yang aktif dulu!"));
      return;
    }

    // ── Cooldown ─────────────────────────────────────────
    if ((lastPull.get(player.id) ?? 0) + CFG.PULL_CD > system.currentTick) {
      system.run(() => player.sendMessage("§e[Gacha] Tunggu sebentar!"));
      return;
    }

    // ── Mulai gacha ──────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════
// 6. PATCH: Pencegahan drop item dari chest terdaftar
//    Prevent entity item yang muncul dari chest gacha.
// ═══════════════════════════════════════════════════════════

/**
 * Daftarkan handler entitySpawn untuk item drop dari chest.
 * GANTIKAN atau TAMBAHKAN ke handler entitySpawn yang ada.
 */
export function registerItemDropGuard() {
  world.afterEvents.entitySpawn.subscribe(ev => {
    try {
      const ent = ev.entity;
      if (ent.typeId !== "minecraft:item") return;
      const stack = ent.getComponent("minecraft:item")?.itemStack;
      if (!stack) return;

      // Hapus item bertanda langsung tanpa cek posisi
      if (stack.nameTag?.startsWith(MARK)) {
        ent.remove();
        return;
      }

      // Cek apakah item muncul di dekat chest terdaftar
      // Optimasi: group chest per dimensi agar tidak iterasi lintas dimensi
      const entDimId = ent.dimension.id;
      const entLoc   = ent.location;
      const chests   = getAllowedChests();
      for (const c of chests) {
        if (c.dimId !== entDimId) continue;
        const dx = entLoc.x - c.x, dy = entLoc.y - c.y, dz = entLoc.z - c.z;
        if (dx*dx + dy*dy + dz*dz <= 4) { // radius 2 blok
          ent.remove();
          return;
        }
      }
    } catch {}
  });
}