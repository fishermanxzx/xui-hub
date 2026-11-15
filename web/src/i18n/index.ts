// 多语言:官方的 vue-i18n。文案都在 zh.ts / en.ts(en 必须和 zh 的键一一对应,少一个编译就不过)。
// 用法:组件和普通模块都从这里 import { t },模板里直接写 t('customers.title');带数量的英文复数用 t(key, { n }, n)。
// 写文案时注意 vue-i18n 的特殊字符:{ } 是插值,| 是复数分隔,@ 是引用,正文里要用就写成 {'|'} 这样。
// 语言:先看用户上次选的(localStorage),没有就跟浏览器;切换后 <html lang> 跟着变,请求里的 Accept-Language 也跟着变。

import { createI18n } from 'vue-i18n';
import en from './en';
import zh from './zh';

export type Locale = 'zh' | 'en';
export type Messages = typeof zh;
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

const STORE_KEY = 'xui-hub.locale';
const isLocale = (v: unknown): v is Locale => v === 'zh' || v === 'en';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // 隐私模式下读不了,跟浏览器
  }
  return (navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith('zh')) ? 'zh' : 'en';
}

export const i18n = createI18n<[Messages], Locale, false>({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'zh',
  messages: { zh, en },
});

export const t = i18n.global.t;
/** 有没有这条文案 */
export const te = (key: string): boolean => i18n.global.te(key);
export const locale = i18n.global.locale;

const htmlLang = (l: Locale) => (l === 'zh' ? 'zh-CN' : 'en');
document.documentElement.lang = htmlLang(locale.value);

export function setLocale(next: Locale): void {
  locale.value = next;
  document.documentElement.lang = htmlLang(next);
  try {
    localStorage.setItem(STORE_KEY, next);
  } catch {
    // 存不了就只管这一次
  }
}
