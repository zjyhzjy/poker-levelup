export function upgradeResultClassic4(attackers) {
  if (attackers === 0) return { side: "dealer", steps: 3, label: "庄家队大光，升 3 级" };
  if (attackers < 40) return { side: "dealer", steps: 2, label: "庄家队小光，升 2 级" };
  if (attackers < 80) return { side: "dealer", steps: 1, label: "庄家队升 1 级" };
  if (attackers < 120) return { side: "attackers", steps: 0, label: "闲家队上台，不升级" };
  if (attackers < 160) return { side: "attackers", steps: 1, label: "闲家队上台，升 1 级" };
  if (attackers < 200) return { side: "attackers", steps: 2, label: "闲家队上台，升 2 级" };
  return { side: "attackers", steps: 3, label: "闲家队上台，升 3 级" };
}

export function buryMultiplierClassic4(shape) {
  if (!shape) return 2;
  if (shape.type === "pair") return 4;
  if (shape.type === "tractor") return 8;
  return 2;
}
