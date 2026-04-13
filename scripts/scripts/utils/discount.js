import { CFG } from "../config.js";
import { dpGet, dpSet } from "./storage.js";

export const getDiscCodes  = ()    => dpGet(CFG.K_DISC, {});
export const saveDiscCodes = (map) => dpSet(CFG.K_DISC, map);
export const getUsedCodes  = pid  => dpGet(CFG.K_USED_DISC + pid, []);
export const hasUsedCode   = (pid, code) => getUsedCodes(pid).includes(code.toUpperCase());

export function markCodeUsed(pid, code) {
  const used = getUsedCodes(pid), key = code.toUpperCase();
  if (!used.includes(key)) { used.push(key); dpSet(CFG.K_USED_DISC + pid, used); }
}

export function validateDisc(code, gachaType, playerId) {
  const map = getDiscCodes(), e = map[code.toUpperCase()];
  if (!e || e.uses <= 0) return null;
  if (e.type !== "ALL" && e.type !== (gachaType === "PARTICLE" ? "PT" : "EQ")) return null;
  if (hasUsedCode(playerId, code)) return null;
  return e;
}

export function consumeDisc(code, playerId) {
  markCodeUsed(playerId, code);
  const map = getDiscCodes(), key = code.toUpperCase();
  if (!map[key]) return;
  map[key].uses--;
  if (map[key].uses <= 0) delete map[key];
  saveDiscCodes(map);
}

/**
 * [FIX M-1] Atomic validate + consume dalam SATU operasi.
 * Mencegah TOCTOU: dua player dengan kode uses=1 tidak bisa keduanya dapat diskon.
 *
 * CARA PAKAI di main.js:
 *   Ganti pola lama:
 *     const entry = validateDisc(code, type, player.id);
 *     pendingDisc.set(player.id, { code, pct: entry.pct, type: entry.type });
 *     // ... nanti: consumeDisc(disc.code, player.id)
 *
 *   Dengan pola baru:
 *     const entry = validateAndConsumeDisc(code, type, player.id);
 *     if (!entry) { player.sendMessage('...'); return; }
 *     pendingDisc.set(player.id, { code, pct: entry.pct, type: entry.type, consumed: true });
 *     // Di executeGachaIntent: HAPUS panggilan consumeDisc — sudah dikonsumsi!
 *     // Hanya: if (disc) pendingDisc.delete(player.id);
 *
 * Trade-off: jika player cancel setelah apply kode, uses berkurang.
 * Ini trade-off wajar untuk mencegah eksploit.
 */
export function validateAndConsumeDisc(code, gachaType, playerId) {
  const map = getDiscCodes(), key = code.toUpperCase();
  const e = map[key];
  if (!e || e.uses <= 0) return null;
  if (e.type !== "ALL" && e.type !== (gachaType === "PARTICLE" ? "PT" : "EQ")) return null;
  if (hasUsedCode(playerId, code)) return null;

  // Consume atomically
  const result = { pct: e.pct, type: e.type, uses: e.uses };
  markCodeUsed(playerId, code);
  map[key].uses--;
  if (map[key].uses <= 0) delete map[key];
  saveDiscCodes(map);
  return result;
}
