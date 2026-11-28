// 机房:像网吧一样的一间间房。客户页是一间大厅(所有客户,一人一台电脑,每条线路一根网线);
// 面板页一块面板一间房、SOCKS 页一个 SOCKS 一间房,房里坐着在上面有线路的客户。
import { t } from './i18n';
import { region } from './format';
import type { Customer, Line, Panel, Socks } from './types';

/** 最近 5 分钟里在面板上在线过 = 在线(每分钟检查一次面板) */
export const ONLINE_MS = 5 * 60_000;
export const lineOnline = (l: Line, now = Date.now()) => l.last_online > 0 && now - l.last_online < ONLINE_MS;
export const linesOnline = (lines: Line[]) => lines.some((l) => lineOnline(l));
/** 线路用到这个 SOCKS:出口是它、出口规则里用了它,或面板上读到的分流规则(含 3x-ui 里手配的)指向它(和 SOCKS 页「N 位客户」一样算) */
export const usesSocks = (l: Line, socksId: number) =>
  l.exit_socks_id === socksId || (l.rules ?? []).some((r) => r.to.kind === 'socks' && r.to.socks_id === socksId) || !!l.routes?.some((h) => h.to.socks_id === socksId);

export interface RoomSeat {
  c: Customer;
  /** 在这间房里算在线:这间房里的线路最近在线过 */
  online: boolean;
}
export interface Room {
  key: string;
  /** 门牌上的房号 */
  no: string;
  name: string;
  /** 在哪:城市 / 地区 · IP */
  where: string;
  /** 连不上 / 测试不通:这间房关灯 */
  down: string;
  /** 空房间时的说明 */
  empty: string;
  seats: RoomSeat[];
  online: number;
  /** 哪些网线接在这间房(其余的画淡);大厅里全算 */
  lineIn?: (l: Line) => boolean;
}

function room(key: string, name: string, seats: RoomSeat[], extra: Partial<Room> = {}): Room {
  return { key, no: '', name, where: '', down: '', empty: '', seats, online: seats.filter((s) => s.online).length, ...extra };
}

/** 客户页:一间大厅,所有(筛出来的)客户 */
export const hallRoom = (customers: Customer[]): Room => room('hall', '', customers.map((c) => ({ c, online: linesOnline(c.lines) })));

/** 坐进这间房的客户:有线路算在这间房里的 */
function seatsIn(customers: Customer[], lineIn: (l: Line) => boolean): RoomSeat[] {
  return customers.flatMap((c) => {
    const ls = c.lines.filter(lineIn);
    return ls.length ? [{ c, online: linesOnline(ls) }] : [];
  });
}
const no = (i: number) => String(i + 1).padStart(2, '0');

/** 面板页:一块面板一间房 */
export function panelRooms(customers: Customer[], panels: Panel[]): Room[] {
  return panels.map((p, i) => {
    const lineIn = (l: Line) => l.panel_id === p.id;
    return room(`p${p.id}`, p.name, seatsIn(customers, lineIn), {
      no: no(i),
      where: [p.geo_city || region(p.geo_country), p.ip].filter(Boolean).join(' · '),
      down: p.check_error ? t('rooms.panelDown') : '',
      empty: t('rooms.emptyPanel'),
      lineIn,
    });
  });
}

/** SOCKS 页:一个 SOCKS 一间房 */
export function socksRooms(customers: Customer[], socks: Socks[]): Room[] {
  return socks.map((s, i) => {
    const lineIn = (l: Line) => usesSocks(l, s.id);
    return room(`s${s.id}`, s.name, seatsIn(customers, lineIn), {
      no: no(i),
      where: s.check?.ok ? [region(s.check.loc), s.check.ip].filter(Boolean).join(' · ') : '',
      down: s.check && !s.check.ok ? t('rooms.socksDown') : '',
      empty: t('rooms.emptySocks'),
      lineIn,
    });
  });
}
