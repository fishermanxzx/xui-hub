// 机房里每个机位的等距 3D 小场景:一块地板、桌子、显示器、桌上一台小主机、椅子、方块小人,主机后面接出网线(一条线路一根)。
// 全用长方体拼,按世界坐标(x 往右下、y 往左下、z 朝上)投成等距视角,只画看得见的三个面(顶、+x、+y)。
// 小人背对我们、面朝显示器;在线坐直打字,时不时抽根烟、喝口饮料、吃零食、伸个懒腰(SCENE_ACT);不在线趴在桌上睡觉。

export interface SceneFace {
  /** 多边形顶点(SVG points);屏幕上的字用 text */
  pts?: string;
  /** 材质 + 面:如 'wood t'(顶)、'wood r'(+x 面,最暗)、'wood l'(+y 面) */
  cls?: string;
  /** 这里画屏幕上的字 */
  text?: true;
  /** 这里冒烟:smoke 烟头上一缕缕的烟,puff 吐出来的一口烟;at 是画面坐标 */
  fx?: 'smoke' | 'puff';
  at?: [number, number];
}

const iso = (x: number, y: number, z: number): [number, number] => [x - y, (x + y) / 2 - z];
const pt = (x: number, y: number, z: number) =>
  iso(x, y, z)
    .map((n) => Math.round(n * 10) / 10)
    .join(',');

/** 一个长方体看得见的三个面:x..x+w、y..y+d、z..z+h */
function box(mat: string, x: number, y: number, z: number, w: number, d: number, h: number): SceneFace[] {
  const [X, Y, Z] = [x + w, y + d, z + h];
  return [
    { cls: `${mat} t`, pts: [pt(x, y, Z), pt(X, y, Z), pt(X, Y, Z), pt(x, Y, Z)].join(' ') },
    { cls: `${mat} r`, pts: [pt(X, y, z), pt(X, Y, z), pt(X, Y, Z), pt(X, y, Z)].join(' ') },
    { cls: `${mat} l`, pts: [pt(x, Y, z), pt(X, Y, z), pt(X, Y, Z), pt(x, Y, Z)].join(' ') },
  ];
}

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => mul(a, 1 / Math.hypot(...a));
const ptv = (q: V3) => pt(q[0], q[1], q[2]);

/**
 * 斜放的长方体:从 o 出发、三条棱 u / v / w。只画朝着我们的面(法线朝 (1,1,1) 那边),
 * 明暗按法线最偏哪个轴:偏上算顶面、偏 +x 算 r、偏 +y 算 l,跟 box 一样。
 */
function solid(mat: string, o: V3, u: V3, v: V3, w: V3): SceneFace[] {
  const c = add(o, mul(add(add(u, v), w), 0.5));
  const sides: [V3, V3, V3][] = [
    [o, u, v],
    [o, u, w],
    [o, v, w],
    [add(o, w), u, v],
    [add(o, v), u, w],
    [add(o, u), v, w],
  ];
  const out: SceneFace[] = [];
  for (const [p, a, b] of sides) {
    let n = cross(a, b);
    if (dot(n, sub(add(p, mul(add(a, b), 0.5)), c)) < 0) n = mul(n, -1);
    if (n[0] + n[1] + n[2] <= 1e-6) continue;
    const side = n[2] >= n[0] && n[2] >= n[1] ? 't' : n[0] >= n[1] ? 'r' : 'l';
    out.push({ cls: `${mat} ${side}`, pts: [p, add(p, a), add(add(p, a), b), add(p, b)].map(ptv).join(' ') });
  }
  return out;
}

/** 一截胳膊 / 一罐饮料 / 一根烟:从 a 到 b、截面 s×s 的方条,两头各多出 ext(关节处好接上) */
function limb(mat: string, a: V3, b: V3, s: number, ext = 0): SceneFace[] {
  const d = unit(sub(b, a));
  let e1 = cross(d, [0, 0, 1]);
  if (Math.hypot(...e1) < 1e-3) e1 = [1, 0, 0];
  e1 = unit(e1);
  const e2 = cross(d, e1);
  const len = Math.hypot(...sub(b, a)) + 2 * ext;
  return solid(mat, sub(sub(a, mul(d, ext)), mul(add(e1, e2), s / 2)), mul(d, len), mul(e1, s), mul(e2, s));
}

/** 一条胳膊:肩 → 肘 → 腕 → 手指尖;袖子是衣服色、手是皮肤色。几截按远近排好(远的先画) */
function arm(cls: string, shoulder: V3, elbow: V3, wrist: V3, tip: V3): SceneFace[] {
  const parts: [V3, SceneFace[]][] = [
    [mul(add(shoulder, elbow), 0.5), limb(`shirt ${cls}`, shoulder, elbow, 4, 1.5)],
    [mul(add(elbow, wrist), 0.5), limb(`shirt ${cls}`, elbow, wrist, 3.6, 1.2)],
    [mul(add(wrist, tip), 0.5), limb(`skin ${cls}`, wrist, tip, 3.2, 0.3)],
  ];
  return parts.sort((x, y) => dot(x[0], [1, 1, 1]) - dot(y[0], [1, 1, 1])).flatMap((x) => x[1]);
}

/** 画面坐标 */
const at = (x: number, y: number, z: number): [number, number] => iso(x, y, z).map((n) => Math.round(n * 10) / 10) as [number, number];

// 显示器屏幕:在显示器朝 +y 的那一面上,留一圈边框
const SCREEN = { x0: 20, x1: 46, y: 13, z0: 31, z1: 48 };
const screenFace: SceneFace = {
  cls: 'screen',
  pts: [pt(SCREEN.x0, SCREEN.y, SCREEN.z0), pt(SCREEN.x1, SCREEN.y, SCREEN.z0), pt(SCREEN.x1, SCREEN.y, SCREEN.z1), pt(SCREEN.x0, SCREEN.y, SCREEN.z1)].join(' '),
};
const [tx, ty] = iso((SCREEN.x0 + SCREEN.x1) / 2, SCREEN.y, (SCREEN.z0 + SCREEN.z1) / 2);
/** 屏幕上的字贴在屏幕那一面上:字的横向沿 +x,竖向沿 -z */
export const SCREEN_TEXT_TRANSFORM = `matrix(1 0.5 0 1 ${Math.round(tx * 10) / 10} ${Math.round(ty * 10) / 10})`;

/** 地板、桌子、显示器、键盘:两种姿势共用,画在最底下 */
const room: SceneFace[] = [
  ...box('floor', 0, 0, -4, 64, 64, 4),
  ...box('wood', 6, 6, 0, 3, 18, 20),
  ...box('wood', 55, 6, 0, 3, 18, 20),
  ...box('wood', 6, 6, 20, 52, 18, 3),
  ...box('metal', 27, 9, 23, 12, 6, 1),
  ...box('metal', 31, 10, 24, 4, 3, 5),
  ...box('metal', 18, 10, 29, 30, 3, 21),
  screenFace,
  { text: true },
  // 桌上右边一台小主机,网线从它朝 +x 的那面接出去;正面一颗电源灯
  ...box('case', 48, 8, 23, 8, 12, 9),
  { cls: 'led', pts: [pt(50, 20, 29), pt(52, 20, 29), pt(52, 20, 30.5), pt(50, 20, 30.5)].join(' ') },
  ...box('metal', 22, 16, 23, 20, 5, 1),
];

/** 桌子右前角一罐饮料(喝的时候拿在手里) */
const deskCan: SceneFace[] = [...box('can', 50, 20.5, 23, 3, 3, 5), ...box('lid', 50, 20.5, 28, 3, 3, 0.6)];

/** 头:皮肤 + 头发(背对我们,后脑勺和头顶是头发) */
const head = (x: number, y: number, z: number): SceneFace[] => [
  ...box('skin', x, y, z, 12, 11, 10),
  ...box('hair', x - 0.5, y, z + 6, 13, 11.5, 6.5),
  ...box('hair', x - 0.5, y + 8, z, 13, 3.5, 6),
];

/** 椅子腿、座、腿脚:两种姿势一样 */
const lower: SceneFace[] = [
  ...box('shoe', 25, 24, 0, 14, 8, 3),
  ...box('pants', 25, 28, 3, 14, 4, 12),
  ...box('chair', 24, 36, 0, 16, 14, 2),
  ...box('chair', 30, 41, 2, 4, 4, 10),
  ...box('chair', 23, 34, 12, 18, 16, 3),
  ...box('pants', 25, 30, 15, 14, 14, 5),
];
const backrest = box('chair', 23, 48, 15, 18, 3, 15);
const torso = box('shirt', 25, 38, 15, 14, 8, 18);
const sitHead = head(26, 36, 34);

/** 打字的两只手:搭在键盘上 */
const typeLeft: SceneFace[] = [...box('skin arm', 21, 16, 24, 4, 3, 3), ...box('shirt arm', 21, 19, 24, 4, 15, 3), ...box('shirt arm', 21, 34, 24, 4, 8, 8)];
const typeRight: SceneFace[] = [...box('skin arm', 39, 16, 24, 4, 3, 3), ...box('shirt arm', 39, 19, 24, 4, 15, 3), ...box('shirt arm', 39, 34, 24, 4, 8, 8)];

/** 坐着的一个人:左手(在身子后面)、身子、右手、头、靠背;front 在头之后画(举到脸边的右手、吐的烟要盖在头上) */
function sitting(desk: SceneFace[], left: SceneFace[], right: SceneFace[], front: SceneFace[] = []): SceneFace[] {
  return [...room, ...desk, ...lower, ...left, ...torso, ...right, ...sitHead, ...front, ...backrest];
}

/** 在线:坐直,两只手在键盘上 */
export const SCENE_WORK: SceneFace[] = sitting(deskCan, typeLeft, typeRight);

/** 不在线:往前趴到桌上,脸埋在胳膊上睡觉 */
export const SCENE_SLEEP: SceneFace[] = [
  ...room,
  ...deskCan,
  ...box('shirt', 19, 15, 23, 26, 9, 4),
  ...head(21, 15, 27),
  ...box('shirt', 23, 23, 23, 18, 9, 6),
  ...lower,
  ...box('shirt', 25, 30, 15, 14, 14, 13),
  ...backrest,
];

const R_SHOULDER: V3 = [41, 41, 30.5];
const L_SHOULDER: V3 = [23, 41, 30.5];

/**
 * 在线时随机做的小动作。有的分两段来回切(类名 pa / pb:一个循环里前 65% 画 pa、后 35% 画 pb),
 * 另一只手接着打字。
 */
export type SeatAct = 'smoke' | 'drink' | 'snack' | 'stretch';
export const SEAT_ACTS: SeatAct[] = ['smoke', 'drink', 'snack', 'stretch'];

/** 抽烟:右手夹着烟搁在肩膀边上冒烟(pa),时不时送到嘴边吸一口(pb),放下来吐一口 */
const smoke: SceneFace[] = (() => {
  const elbow: V3 = [42.5, 37, 22.5];
  const hold = [
    ...arm('pa', R_SHOULDER, elbow, [43.8, 33, 30.5], [44, 32.4, 34]),
    ...limb('cig pa', [44.2, 32.6, 33.5], [47, 31.8, 36.9], 0.9),
    ...limb('ember pa', [47, 31.8, 36.9], [47.4, 31.7, 37.4], 1),
    { fx: 'smoke' as const, cls: 'pa', at: at(47.6, 31.6, 38.1) },
  ];
  const puff = [
    ...arm('pb', R_SHOULDER, elbow, [40, 32, 35], [38.5, 31.5, 37.6]),
    ...limb('cig pb', [38.6, 31.8, 38.4], [35.8, 31, 39.2], 0.9),
  ];
  return sitting(deskCan, typeLeft, [], [...hold, ...puff, { fx: 'puff', at: at(33, 31, 44) }]);
})();

/** 喝饮料:桌上那罐拿起来仰着喝(pa),放下来歇一下(pb) */
const drink: SceneFace[] = (() => {
  const sip = [
    ...arm('pa', R_SHOULDER, [46, 35.5, 31.5], [40.8, 31, 38.4], [39.6, 30.6, 40.4]),
    ...limb('can pa', [38.4, 31.4, 39.4], [43.2, 29.4, 45], 3.4),
  ];
  const rest = [
    ...box('can pb', 43, 27.5, 25, 3.2, 3.2, 6),
    ...box('lid pb', 43, 27.5, 31, 3.2, 3.2, 0.6),
    ...arm('pb', R_SHOULDER, [43.5, 37, 22.5], [44.2, 31.5, 26.5], [44.4, 29.6, 28.2]),
  ];
  return sitting([], typeLeft, [], [...sip, ...rest]);
})();

/** 吃零食:键盘右边一包薯片,右手伸进去抓(pb),送到嘴边嚼(pa);左手接着打字 */
const snack: SceneFace[] = (() => {
  const [bagTop, ...bagSides] = box('bag', 42, 13.5, 23, 5.5, 6, 7.5);
  const band = box('band', 42, 13.5, 26, 5.5, 6, 2.2).slice(1);
  const reach = arm('pb', R_SHOULDER, [44, 32, 24], [45.2, 21, 30.5], [45, 17.8, 28]);
  const eat = arm('pa', R_SHOULDER, [45, 35.5, 25], [40.5, 32, 35.5], [38.8, 31.6, 37.8]);
  // 桌上的东西(薯片袋子正面、那罐饮料)要盖住伸进袋子里的那只手,所以画在手后面
  return sitting([bagTop], typeLeft, [], [...reach, ...bagSides, ...band, ...deskCan, ...eat]);
})();

/** 伸懒腰:两只手举过头顶 */
const stretch: SceneFace[] = sitting(
  deskCan,
  arm('reach', L_SHOULDER, [20.5, 41.5, 40.5], [20, 41, 49.5], [20, 41, 53]),
  [],
  arm('reach', R_SHOULDER, [43.5, 41.5, 40.5], [44, 41, 49.5], [44, 41, 53]),
);

export const SCENE_ACT: Record<SeatAct, SceneFace[]> = { smoke, drink, snack, stretch };
/** 每个动作做多久(毫秒) */
export const ACT_MS: Record<SeatAct, number> = { smoke: 13000, drink: 8000, snack: 10000, stretch: 4500 };

/** 最多画几根网线(线路更多时只画这么多,条数写在名牌上) */
export const MAX_CABLES = 8;
/**
 * 第 i 根网线(共 n 根)的折线:从主机朝 +x 那面的网口出来,翻过桌边,顺着右边桌腿下到地上,
 * 在地板上散开走到右边沿,再从地板侧面垂下去(接到下面的网络)。
 */
function cable(i: number, n: number): string {
  const py = 10 + (i % 4) * 2.6;
  const pz = n > 4 ? 25 + Math.floor(i / 4) * 3 : 26.5;
  const fy = 16 + (n > 1 ? (i * 40) / (n - 1) : 20);
  return [pt(56, py, pz), pt(59.5, py, pz - 1.5), pt(59.5, py, 1), pt(61, fy, 0.4), pt(64, fy, 0.4), pt(64, fy, -9)].join(' ');
}
const cableCache = new Map<number, string[]>();
/** n 根网线各自的折线点 */
export function cables(n: number): string[] {
  const k = Math.min(n, MAX_CABLES);
  let got = cableCache.get(k);
  if (!got) {
    got = Array.from({ length: k }, (_, i) => cable(i, k));
    cableCache.set(k, got);
  }
  return got;
}

/** 睡觉时冒的 z(画面坐标) */
export const ZZZ = [
  { x: -9, y: -20 },
  { x: -3, y: -28 },
];

/** 画面范围:地板四个角 + 显示器顶,四周留一点 */
export const SEAT_VIEWBOX = (() => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of [...SCENE_WORK, ...SCENE_SLEEP, ...cables(MAX_CABLES).map((pts) => ({ pts }))]) {
    for (const p of f.pts?.split(' ') ?? []) {
      const [a, b] = p.split(',').map(Number);
      xs.push(a);
      ys.push(b);
    }
  }
  const pad = 4;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys, ...ZZZ.map((z) => z.y - 8)) - pad;
  return `${x0} ${y0} ${Math.max(...xs) + pad - x0} ${Math.max(...ys) + pad - y0}`;
})();
