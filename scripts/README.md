# ✦ GACHA CHEST ADDON — Minecraft Bedrock Edition

## CARA INSTALL
1. Rename file `GachaAddon_BP.zip` → `GachaAddon_BP.mcpack`
2. Klik/buka file `.mcpack` → otomatis import ke Minecraft
3. Buat atau buka world → Settings → Behavior Packs → Aktifkan **Gacha Chest**
4. **Aktifkan "Beta APIs"** di Experiments (wajib untuk Scripting API)

---

## CARA PAKAI
| Langkah | Aksi |
|---------|------|
| 1 | Beri koin ke player via command |
| 2 | Pegang **Nether Star** di tangan utama |
| 3 | Klik kanan **Chest** biasa |
| 4 | Pilih **Pull 1x** atau **Pull 10x** |
| 5 | Tunggu animasi rolling (~4 detik) |
| 6 | Item otomatis masuk inventory |

---

## COMMAND KOIN
```
# Beri 100 koin ke diri sendiri
/scoreboard players set @s koin 100

# Beri koin ke semua player
/scoreboard players set @a koin 500

# Cek koin semua player
/scoreboard players list koin

# Tampilkan koin di sidebar
/scoreboard objectives setdisplay sidebar koin
```

---

## DROP RATE
| Rarity    | Warna | Chance |
|-----------|-------|--------|
| Common    | §7Abu  | 60%    |
| Uncommon  | §aHijau| 25%    |
| Rare      | §9Biru | 10%    |
| Epic      | §5Ungu | 4%     |
| Legendary | §6Emas | 1%     |

---

## ITEM POOL
### Common (60%)
- Pedang Kayu, Helm Kulit, Baju Kulit, Celana Kulit, Steak Panggang, Joran Pancing

### Uncommon (25%)
- Pedang Besi, Baju Besi, Helm Besi, Busur Api, Perisai Besi

### Rare (10%)
- Pedang Diamond, Baju Diamond, Helm Diamond, Panah Silang Rune

### Epic (4%)
- Pedang Netherite, Baju Netherite, Helm Netherite, Totem Abadi

### Legendary (1%)
- Sayap Naga Abadi (Elytra), Trisula Lautan (Trident)

---

## HARGA
| Pull | Harga |
|------|-------|
| 1x   | 50 Koin |
| 10x  | 450 Koin (hemat 50 koin!) |

---

## CARA TAMBAH ITEM BARU
Edit `scripts/main.js`, tambahkan di array `ITEM_POOL`:
```javascript
{ id: "minecraft:enchanted_golden_apple", name: "Apel Dewa", rarity: "LEGENDARY" },
```

---

## REQUIREMENT
- Minecraft Bedrock / Pocket Edition 1.21.0+
- Beta APIs (aktifkan di Experiments)
- Scripting API: @minecraft/server 1.15.0

---

## TROUBLESHOOTING
| Masalah | Solusi |
|---------|--------|
| Chest terbuka biasa | Pastikan Nether Star di tangan utama |
| Tidak ada UI | Aktifkan Beta APIs di Experiments |
| Item tidak muncul | Cek inventory tidak penuh |
| Koin tidak berubah | Buat objective dulu: `/scoreboard objectives add koin dummy` |
