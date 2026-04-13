export const CFG = {
  TRIGGER:          "minecraft:amethyst_shard",
  GEM_OBJ:          "gem",
  COIN_OBJ:         "coin",
  PT_COST_1:        10,
  PT_COST_10:       90,
  EQ_COST_1:        50,
  EQ_COST_10:       450,
  GEM_REFUND:       5,
  ANIM_TICKS:       72,
  OPEN_TIMEOUT:     1200,
  GUARD_INT:        5,
  REVEAL_INT:       12,
  REVEAL_PAUSE:     22,
  PULL_CD:          40,
  PT_PITY_RARE:     300,
  EQ_PITY_RARE:     500,
  EQ_PITY_LEG:      200,
  MAX_PENDING:      50,
  ADMIN_TAG:        "mimi",
  K_PT_STATS:       "pg_s:",
  K_EQ_STATS:       "eq_s:",
  K_EQ_PITY:        "eq_py:",
  K_EQ_PEND:        "eq_p:",
  K_HIST:           "hist:",
  K_GLOBAL_HIST:    "g_hist",
  K_DISC:           "disc_codes",
  K_USED_DISC:      "ud:",
  K_PLAYER_REG:     "p_reg",
  K_PT_DATA:        "pt_d:",
  K_IMPORT_PEND:    "imp_p:",
  ACTIONBAR_INT:    10,
  ACTIONBAR_REFRESH:55,
  CHEST_CACHE_TTL:  60,
  CHEST_SCAN_R:     5,
  CHEST_SCAN_Y:     3,
  LB_LIMIT:         10,
  EXPORT_VER_BULK:  "GSALL5",
  CHUNK_SZ:         2800,
};

export const T          = { GEM: "cg:", PTPY: "cpp:" };
export const CHEST_BASE = { PARTICLE: "minecraft:amethyst_block", EQUIPMENT: "minecraft:crying_obsidian" };
export const SLOT       = { T:4, B:22, L2:11, L1:12, C:13, R1:14, R2:15 };
export const R_KEYS     = ["COMMON","UNCOMMON","RARE","EPIC","LEGENDARY"];
export const R_INIT     = { C:"COMMON", U:"UNCOMMON", R:"RARE", E:"EPIC", L:"LEGENDARY" };
export const HR         = "§8──────────────────";
export const EXPORT_VER = "GS5";
export const MARK       = "\u00A70\u00A7r\u00A7k\u00A7r";

export const R = {
  COMMON:    { color:"§7", label:"Biasa",     glass:"minecraft:gray_stained_glass_pane",   ptW:55, eqW:70 }, 
  UNCOMMON:  { color:"§a", label:"Tak Biasa",  glass:"minecraft:lime_stained_glass_pane",   ptW:25, eqW:22 }, 
  RARE:      { color:"§9", label:"Langka",     glass:"minecraft:blue_stained_glass_pane",   ptW:13, eqW:6.5}, 
  EPIC:      { color:"§5", label:"Epik",       glass:"minecraft:purple_stained_glass_pane", ptW: 6, eqW: 1.45}, 
  LEGENDARY: { color:"§6", label:"Legendaris", glass:"minecraft:yellow_stained_glass_pane", ptW: 1, eqW: 0.05}, 
};

export const PT_POOL = [
  { name:"Slime Trail",    tag:"basic_slime",      rarity:"COMMON",    visual:"minecraft:slime_ball"        },
  { name:"Cloud Trail",    tag:"basic_cloud",      rarity:"COMMON",    visual:"minecraft:snowball"          },
  { name:"Ice Trail",      tag:"basic_ice",        rarity:"COMMON",    visual:"minecraft:packed_ice"        },
  { name:"Static Ring",    tag:"elite_stat",       rarity:"UNCOMMON",  visual:"minecraft:quartz"            },
  { name:"Small Ring",     tag:"elite_smallr",     rarity:"UNCOMMON",  visual:"minecraft:glowstone_dust"    },
  { name:"SF Ring",        tag:"elite_sf",         rarity:"UNCOMMON",  visual:"minecraft:gold_nugget"       },
  { name:"Negative Ring",  tag:"elite_neg",        rarity:"UNCOMMON",  visual:"minecraft:coal"              },
  { name:"Gravity Aura",   tag:"elite_gravity",    rarity:"UNCOMMON",  visual:"minecraft:ender_pearl"       },
  { name:"E-Static Aura",  tag:"epic_estat",       rarity:"RARE",      visual:"minecraft:amethyst_shard"    },
  { name:"Sash Coil",      tag:"epic_scoil",       rarity:"RARE",      visual:"minecraft:prismarine_shard"  },
  { name:"Ash Coil",       tag:"epic_acoil",       rarity:"RARE",      visual:"minecraft:iron_nugget"       },
  { name:"Sash Coil II",   tag:"epic_scoil2",      rarity:"RARE",      visual:"minecraft:emerald"           },
  { name:"Ash Coil II",    tag:"epic_acoil2",      rarity:"RARE",      visual:"minecraft:diamond"           },
  { name:"Nature Tree",    tag:"legendary_tree",   rarity:"EPIC",      visual:"minecraft:oak_sapling"       },
  { name:"Leaf Storm",     tag:"legendary_leaf",   rarity:"EPIC",      visual:"minecraft:wheat_seeds"       },
  { name:"Portal Vortex",  tag:"legendary_portal", rarity:"EPIC",      visual:"minecraft:magma_cream"       },
  { name:"Spectral Sword", tag:"legendary_sword",  rarity:"EPIC",      visual:"minecraft:blaze_rod"         },
  { name:"Anya Special",   tag:"adxP",             rarity:"LEGENDARY", visual:"minecraft:nether_star"       },
];

export const EQ_POOL = [
  // ================= COMMON =================
  { id: "minecraft:wooden_sword",         name: "Pedang Kayu",       rarity: "COMMON" },
  { id: "minecraft:stone_pickaxe",        name: "Beliung Batu",      rarity: "COMMON" },
  { id: "minecraft:stone_axe",            name: "Kapak Batu",        rarity: "COMMON" },
  { id: "minecraft:leather_helmet",       name: "Helm Kulit",        rarity: "COMMON" },
  { id: "minecraft:leather_chestplate",   name: "Baju Kulit",        rarity: "COMMON" },
  { id: "minecraft:leather_leggings",     name: "Celana Kulit",      rarity: "COMMON" },
  { id: "minecraft:leather_boots",        name: "Sepatu Kulit",      rarity: "COMMON" },
  { id: "minecraft:cooked_beef",          name: "Steak x8",          rarity: "COMMON", qty: 8 },
  { id: "minecraft:bread",                name: "Roti x16",          rarity: "COMMON", qty: 16 },
  { id: "minecraft:fishing_rod",          name: "Joran Pancing",     rarity: "COMMON" },
  { id: "minecraft:water_bucket",         name: "Ember Air",         rarity: "COMMON" },
  { id: "minecraft:torch",                name: "Obor x32",          rarity: "COMMON", qty: 32 },

  // ================= UNCOMMON =================
  { id: "minecraft:iron_sword",           name: "Pedang Besi",       rarity: "UNCOMMON" },
  { id: "minecraft:iron_pickaxe",         name: "Beliung Besi",      rarity: "UNCOMMON" },
  { id: "minecraft:iron_axe",             name: "Kapak Besi",        rarity: "UNCOMMON" },
  { id: "minecraft:iron_helmet",          name: "Helm Besi",         rarity: "UNCOMMON" },
  { id: "minecraft:iron_chestplate",      name: "Baju Besi",         rarity: "UNCOMMON" },
  { id: "minecraft:iron_leggings",        name: "Celana Besi",       rarity: "UNCOMMON" },
  { id: "minecraft:iron_boots",           name: "Sepatu Besi",       rarity: "UNCOMMON" },
  { id: "minecraft:bow",                  name: "Busur",             rarity: "UNCOMMON" },
  { id: "minecraft:arrow",                name: "Panah x32",         rarity: "UNCOMMON", qty: 32 },
  { id: "minecraft:shield",               name: "Perisai",           rarity: "UNCOMMON" },
  { id: "minecraft:golden_apple",         name: "Apel Emas x2",      rarity: "UNCOMMON", qty: 2 },

  // ================= RARE =================
  { id: "minecraft:diamond_sword",        name: "Pedang Diamond",    rarity: "RARE" },
  { id: "minecraft:diamond_pickaxe",      name: "Beliung Diamond",   rarity: "RARE" },
  { id: "minecraft:diamond_axe",          name: "Kapak Diamond",     rarity: "RARE" },
  { id: "minecraft:diamond_helmet",       name: "Helm Diamond",      rarity: "RARE" },
  { id: "minecraft:diamond_chestplate",   name: "Baju Diamond",      rarity: "RARE" },
  { id: "minecraft:diamond_leggings",     name: "Celana Diamond",    rarity: "RARE" },
  { id: "minecraft:diamond_boots",        name: "Sepatu Diamond",    rarity: "RARE" },
  { id: "minecraft:crossbow",             name: "Crossbow",          rarity: "RARE" },
  { id: "minecraft:trident",              name: "Trident",           rarity: "RARE" },
  { id: "minecraft:obsidian",             name: "Obsidian x14",      rarity: "RARE", qty: 14 }, 

  // ================= EPIC =================
  { id: "minecraft:netherite_sword",      name: "Pedang Netherite",  rarity: "EPIC" },
  { id: "minecraft:netherite_pickaxe",    name: "Beliung Netherite", rarity: "EPIC" },
  { id: "minecraft:netherite_helmet",     name: "Helm Netherite",    rarity: "EPIC" },
  { id: "minecraft:netherite_chestplate", name: "Baju Netherite",    rarity: "EPIC" },
  { id: "minecraft:netherite_leggings",   name: "Celana Netherite",  rarity: "EPIC" },
  { id: "minecraft:netherite_boots",      name: "Sepatu Netherite",  rarity: "EPIC" },
  { id: "minecraft:totem_of_undying",     name: "Totem Abadi",       rarity: "EPIC" },

  // ================= LEGENDARY =================
  { id: "minecraft:netherite_block",      name: "BLOCK OF NETHERITE",   rarity: "LEGENDARY" },
  { id: "minecraft:mace",                 name: "THE CRUSHING MACE",    rarity: "LEGENDARY" },
  { id: "minecraft:enchanted_golden_apple", name: "NOTCH APPLE x10",    rarity: "LEGENDARY", qty: 10 },
  { id: "minecraft:heavy_core",           name: "ANCIENT HEAVY CORE",   rarity: "LEGENDARY" },
  { id: "minecraft:nether_star",          name: "SOUL OF THE WITHER",   rarity: "LEGENDARY" },
  { id: "minecraft:beacon",               name: "HOLY BEACON",          rarity: "LEGENDARY" }
];

export const PT_TAG_SET = new Set(PT_POOL.map(p => p.tag));
export const EQ_IDX     = new Map(EQ_POOL.map((it, i) => [it.id, i]));

function buildWeighted(pool, wKey) {
  let total = 0;
  const items = pool.map(it => { const w = R[it.rarity][wKey]; total += w; return { item: it, w }; });
  return { items, total };
}
export const PT_WP      = buildWeighted(PT_POOL, "ptW");
export const EQ_WP      = buildWeighted(EQ_POOL, "eqW");
export const PT_TOTAL_W = PT_WP.total;
export const EQ_TOTAL_W = EQ_WP.total;
export const PT_RARE    = PT_POOL.filter(i => R_KEYS.indexOf(i.rarity) >= 2);
export const EQ_RARE    = EQ_POOL.filter(i => R_KEYS.indexOf(i.rarity) >= 2);
export const EQ_LEG     = EQ_POOL.filter(i => i.rarity === "LEGENDARY");

export const rand  = arr => arr[Math.floor(Math.random() * arr.length)];
export const randW = ({ items, total }) => {
  let r = Math.random() * total;
  for (const { item, w } of items) { r -= w; if (r <= 0) return item; }
  return items[items.length - 1].item;
};

export const SFX = {
  OPEN:    { id:"random.click",     pitch:1.3, vol:0.7  },
  PAY:     { id:"random.orb",       pitch:0.8, vol:1.0  },
  READY:   { id:"block.chest.open", pitch:1.2, vol:1.0  },
  TIMEOUT: { id:"note.bass",        pitch:0.5, vol:1.0  },
  BROKE:   { id:"note.bass",        pitch:0.6, vol:1.0  },
  CLAIM:   { id:"random.levelup",   pitch:1.0, vol:1.0  },
  TICK:    { id:"note.pling",       pitch:1.5, vol:0.35 },
  DUP:     { id:"random.orb",       pitch:0.6, vol:0.8  },
  LEG2:    { id:"random.anvil_use", pitch:0.4, vol:1.0  },
  ADMIN:   { id:"random.levelup",   pitch:1.8, vol:1.0  },
  REVEAL: {
    COMMON:    { id:"random.pop",     pitch:1.0, vol:0.8 },
    UNCOMMON:  { id:"random.orb",     pitch:1.1, vol:1.0 },
    RARE:      { id:"note.pling",     pitch:1.5, vol:1.0 },
    EPIC:      { id:"random.levelup", pitch:1.3, vol:1.0 },
    LEGENDARY: { id:"ambient.weather.thunder", pitch: 0.5, vol: 2.0 },
  },
};

export const activePlayers        = new Map();
export const activeChests         = new Map();
export const chestExpected        = new Map();
export const lockSet              = new Set();
export const lastPull             = new Map();
export const pendingDisc          = new Map();
export const chestCache           = new Map();
export const lastActionBar        = new Map();
export const pendingChestInteract = new Set();

export const ck     = b => `${Math.floor(b.location.x)},${Math.floor(b.location.y)},${Math.floor(b.location.z)}`;
export const bar    = (v, max, len = 10) => { const f = Math.min(Math.round(v / max * len), len); return `§e${"█".repeat(f)}§8${"█".repeat(len - f)}`; };
export const pctStr = (v, total) => total > 0 ? (v / total * 100).toFixed(1) : "0.0";
export const isMark = item => typeof item?.nameTag === "string" && item.nameTag.startsWith(MARK);