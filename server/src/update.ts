// xui-hub 自己的版本检查和后台里点的更新。
// 检查:问 GitHub 最新的发布版本,和当前版本比(结果缓存 6 小时,可以手动重查)。
// 更新:一键脚本装的,服务本身不是 root、改不了程序目录,所以只在数据目录放一个请求文件;
// 系统里的 xui-hub-update.path 看到它就以 root 跑 `xui-hub update`(和在服务器上敲这条命令一样),日志写到 UPDATE_LOG。
// Docker 装的容器换不了自己的镜像,只提示要在宿主机上执行的命令。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from './panels/repo';
import { errorText } from './util';

export const REPO = 'fishermanxzx/xui-hub';
const UPDATE_UNIT = '/etc/systemd/system/xui-hub-update.path';
const UPDATE_LOG = '/var/log/xui-hub-update.log';
const REQUEST_FILE = 'update-request';
const CHECK_TTL_MS = 6 * 3_600_000;
const ERROR_TTL_MS = 10 * 60_000;
/** 更新一般一两分钟;日志超过这么久没写完就不再当它还在跑 */
const RUN_STALE_MS = 15 * 60_000;

export type UpdateMethod = 'auto' | 'docker' | 'manual';

export interface UpdateInfo {
  current: string;
  /** 最新的发布版本;还没查到是 null */
  latest: string | null;
  update_available: boolean;
  /** auto = 后台里能直接更新;docker / manual = 给出要在服务器上执行的命令 */
  method: UpdateMethod;
  command: string;
  checked_at: number | null;
  /** 查版本失败的原因 */
  error: string | null;
  /** 后台里点的更新:running 进行中;failed 上一次没成(log 是脚本最后的输出) */
  state: 'idle' | 'running' | 'failed';
  log: string;
  release_url: string;
}

/** a 比 b 新返回正数。只比 x.y.z 三段数字;认不出的(dev)当成最旧 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [x, y] = [parts(a), parts(b)];
  if (!x.length || !y.length) return x.length - y.length;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** GitHub API 限流(同一 IP 每小时 60 次)时退到 releases/latest 的跳转地址 */
export async function fetchLatestVersion(): Promise<string> {
  const headers = { 'User-Agent': 'xui-hub', Accept: 'application/vnd.github+json' };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(8000) });
    const tag = res.ok ? String(((await res.json()) as any)?.tag_name ?? '') : '';
    if (/^v?\d+\.\d+\.\d+/.test(tag)) return tag.replace(/^v/, '');
  } catch {
    // 走下面的跳转
  }
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { method: 'HEAD', redirect: 'manual', headers, signal: AbortSignal.timeout(8000) });
  const tag = /\/tag\/v?(\d+\.\d+\.\d+[^/]*)$/.exec(res.headers.get('location') ?? '')?.[1];
  if (!tag) throw new Error('从 GitHub 取不到最新版本号');
  return tag;
}

/** 去掉脚本输出里的颜色码,只留最后几行 */
const tail = (text: string, lines = 12) => text.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-lines).join('\n');

export interface UpdaterOptions {
  version: string;
  dataDir: string;
  /** Docker 镜像里跑(镜像构建时写了 XUIHUB_VERSION) */
  docker: boolean;
  fetchLatest?: () => Promise<string>;
  /** 测试里换路径 */
  unitPath?: string;
  logPath?: string;
}

export function createUpdater(opts: UpdaterOptions) {
  const fetchLatest = opts.fetchLatest ?? fetchLatestVersion;
  const unitPath = opts.unitPath ?? UPDATE_UNIT;
  const logPath = opts.logPath ?? UPDATE_LOG;
  const requestPath = join(opts.dataDir, REQUEST_FILE);
  const method: UpdateMethod = opts.docker ? 'docker' : existsSync(unitPath) ? 'auto' : 'manual';
  let latest: string | null = null;
  let checkedAt: number | null = null;
  let error: string | null = null;
  let pending: Promise<void> | null = null;

  async function check(now: number): Promise<void> {
    try {
      latest = await fetchLatest();
      error = null;
    } catch (e) {
      error = errorText(e);
    }
    checkedAt = now;
  }

  function runState(now: number): Pick<UpdateInfo, 'state' | 'log'> {
    if (existsSync(requestPath)) return { state: 'running', log: '' };
    let text = '';
    let mtime = 0;
    try {
      text = readFileSync(logPath, 'utf8');
      mtime = statSync(logPath).mtimeMs;
    } catch {
      return { state: 'idle', log: '' };
    }
    const exit = /^exit=(\d+)\s*$/m.exec(text.slice(-40));
    if (!exit) return now - mtime < RUN_STALE_MS ? { state: 'running', log: tail(text) } : { state: 'idle', log: '' };
    // 更新成功后服务已经是新版本:只有「没成功、而且现在还落后」才算失败
    const failed = exit[1] !== '0' && latest != null && compareVersions(latest, opts.version) > 0;
    return failed ? { state: 'failed', log: tail(text.replace(/^exit=\d+\s*$/m, '')) } : { state: 'idle', log: '' };
  }

  return {
    async info(force = false, now = Date.now()): Promise<UpdateInfo> {
      const ttl = error ? ERROR_TTL_MS : CHECK_TTL_MS;
      if (force || checkedAt == null || now - checkedAt > ttl) {
        pending ??= check(now).finally(() => (pending = null));
        await pending;
      }
      return {
        current: opts.version,
        latest,
        update_available: latest != null && compareVersions(latest, opts.version) > 0,
        method,
        command: method === 'docker' ? 'docker compose pull && docker compose up -d' : 'xui-hub update',
        checked_at: checkedAt,
        error,
        ...runState(now),
        release_url: `https://github.com/${REPO}/releases`,
      };
    },

    /** 请求更新到最新版:放下请求文件就返回,更新在后台跑(期间服务会重启) */
    async start(now = Date.now()): Promise<void> {
      if (method !== 'auto') throw new InputError(method === 'docker' ? 'Docker 部署要在服务器上更新:docker compose pull && docker compose up -d' : '这台机器上没有装自动更新的服务,在服务器上执行一次 xui-hub update 就有了');
      const info = await this.info(false, now);
      if (info.state === 'running') throw new InputError('已经在更新了,等它跑完');
      if (!info.update_available) throw new InputError('已经是最新版本');
      writeFileSync(requestPath, `${now}\n`, { mode: 0o600 });
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
