// 客户页「机房」里每个机位的等距 3D 小场景:一块地板、桌子、显示器、椅子、方块小人。
// 全用长方体拼,按世界坐标(x 往右下、y 往左下、z 朝上)投成等距视角,只画看得见的三个面(顶、+x、+y)。
// 小人背对我们、面朝显示器;在线坐直打字,不在线趴在桌上睡觉。

export interface SceneFace {
  /** 多边形顶点(SVG points);屏幕上的字用 text */
  pts?: string;
  /** 材质 + 面:如 'wood t'(顶)、'wood r'(+x 面,最暗)、'wood l'(+y 面) */
  cls?: string;
  /** 这里画屏幕上的字 */
  text?: true;
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
  ...box('metal', 22, 16, 23, 20, 5, 1),
];

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

/** 在线:坐直,两只手在键盘上 */
export const SCENE_WORK: SceneFace[] = [
  ...room,
  ...lower,
  ...box('skin arm', 21, 16, 24, 4, 3, 3),
  ...box('shirt arm', 21, 19, 24, 4, 15, 3),
  ...box('shirt arm', 21, 34, 24, 4, 8, 8),
  ...box('shirt', 25, 38, 15, 14, 8, 18),
  ...box('skin arm', 39, 16, 24, 4, 3, 3),
  ...box('shirt arm', 39, 19, 24, 4, 15, 3),
  ...box('shirt arm', 39, 34, 24, 4, 8, 8),
  ...head(26, 36, 34),
  ...backrest,
];

/** 不在线:往前趴到桌上,脸埋在胳膊上睡觉 */
export const SCENE_SLEEP: SceneFace[] = [
  ...room,
  ...box('shirt', 19, 15, 23, 26, 9, 4),
  ...head(21, 15, 27),
  ...box('shirt', 23, 23, 23, 18, 9, 6),
  ...lower,
  ...box('shirt', 25, 30, 15, 14, 14, 13),
  ...backrest,
];

/** 睡觉时冒的 z(画面坐标) */
export const ZZZ = [
  { x: -9, y: -20 },
  { x: -3, y: -28 },
];

/** 画面范围:地板四个角 + 显示器顶,四周留一点 */
export const SEAT_VIEWBOX = (() => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of [...SCENE_WORK, ...SCENE_SLEEP]) {
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
