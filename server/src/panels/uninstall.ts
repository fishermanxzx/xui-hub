// 卸载面板(过期了、或者不想要了的):从客户名下删掉这块面板上的线路,再把面板从这里移除。
// - 面板连得上:先把这些线路在面板上的客户端删掉(链接立即失效),中转 / 配了出口规则的线路的路由规则一起去掉;
//   面板上的入站和不是线路的客户端不动。删到一半失败就停下、什么记录都不删,再点一次会接着删(已经删掉的算成功)。
// - 连不上(读不到客户端列表,包括登录不上):直接删记录,面板上的客户端留在那边。
// - force:不连面板,直接删记录(连得上但一直删不掉时用)。
// 线路本期用掉的流量结转到客户身上,已用不变;流量记录、面板的名字和倍率留着(见 deletePanel),id 不会给新面板用。
// 整个过程和这块面板上的开 / 删线路排队,卸载途中不会有新线路开到它上面。

import { linesOnPanel } from '../customers/repo';
import type { DB } from '../db';
import { removeRoutes } from '../lines/relay';
import { routesOf, type LineAdmin } from '../lines/open';
import { errorText, panelKey, serial, using } from '../util';
import { XUIError } from '../xui/client';
import { deletePanel, getPanel, InputError, type Panel } from './repo';

export interface UninstallResult {
  name: string;
  /** 从客户名下删掉的线路条数、涉及几位客户 */
  lines: number;
  customers: number;
  /**
   * 面板上怎么处理的:deleted = 连上了,客户端删掉了;unreachable = 连不上,只删了记录;
   * skipped = 选了只删记录,没连面板;none = 上面没有线路,不用连
   */
  remote: 'deleted' | 'unreachable' | 'skipped' | 'none';
  /** 这次在面板上删掉的客户端个数(面板上本来就没有的不算) */
  clients_deleted: number;
  /** 连不上的原因 */
  error: string;
}

export async function uninstallPanel(db: DB, id: number, adminFor: (panel: Panel) => LineAdmin, opts: { force?: boolean } = {}): Promise<UninstallResult> {
  if (!getPanel(db, id)) throw new InputError('面板不存在');
  return serial(panelKey(id), async () => {
    // 排队轮到时再读一遍:前面可能刚开了 / 删了线路,或者面板已经被删了
    const panel = getPanel(db, id);
    if (!panel) throw new InputError('面板不存在');
    const lines = linesOnPanel(db, id);
    const result: UninstallResult = { name: panel.name, lines: lines.length, customers: new Set(lines.map((l) => l.customer_id)).size, remote: 'none', clients_deleted: 0, error: '' };
    if (lines.length && opts.force) result.remote = 'skipped';
    else if (lines.length) {
      await using(adminFor(panel), async (admin) => {
        let present: Set<string>;
        try {
          present = new Set((await admin.listClients()).map((c) => String(c.email)));
        } catch (e) {
          result.remote = 'unreachable';
          result.error = errorText(e);
          return;
        }
        try {
          for (const line of lines) {
            if (!present.has(line.email)) continue;
            await admin.deleteClient(line.email);
            result.clients_deleted++;
          }
          const routes = await routesOf(admin, lines);
          if (routes.length) await removeRoutes(admin, routes);
        } catch (e) {
          throw new XUIError(
            `面板「${panel.name}」连得上,但没删完上面的客户端(这次删了 ${result.clients_deleted} 个):${errorText(e)}。面板和线路都还在,可以再卸载一次接着删;一直删不掉的话,可以选只删记录`,
          );
        }
        result.remote = 'deleted';
      });
    }
    deletePanel(db, id, true);
    return result;
  });
}
