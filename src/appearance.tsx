import { useLayoutEffect, useState } from 'react';
import { Check, Grid2X2, Monitor, Moon, Square, Sun } from 'lucide-react';
import './appearance.css';

type Mode = 'light' | 'dark' | 'system';
type Appearance = { mode: Mode; accent: string; previewBackground: 'solid' | 'checker' };
const storageKey = 'prism.appearance.v1';
const defaults: Appearance = { mode: 'light', accent: '#3b6ee8', previewBackground: 'solid' };
export const accentPresets = [
  { name: '蓝色', color: '#3b6ee8' }, { name: '绿色', color: '#19836a' },
  { name: '紫色', color: '#8060cf' }, { name: '橙色', color: '#bd6726' },
  { name: '玫瑰', color: '#c55078' },
];
const modes = [{ value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const;
const validColor = (color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return { mode: ['light', 'dark', 'system'].includes(saved?.mode) ? saved.mode : defaults.mode,
      accent: validColor(saved?.accent) ? saved.accent.toLowerCase() : defaults.accent,
      previewBackground: saved?.previewBackground === 'checker' ? 'checker' : 'solid' };
  } catch { return { ...defaults }; }
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => rgb(hex).reduce((sum, channel, i) => {
  const value = channel / 255;
  return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
}, 0);
const contrast = (a: string, b: string) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
};
function readableAccent(accent: string, dark: boolean) {
  const source = rgb(accent), target = dark ? 255 : 0, background = dark ? '#29292b' : '#eeeeec';
  for (let step = 0; step <= 20; step++) {
    const color = '#' + source.map(v => Math.round(v + (target - v) * step / 20).toString(16).padStart(2, '0')).join('');
    if (contrast(color, background) >= 4.8) return color;
  }
  return dark ? '#ffffff' : '#000000';
}
function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  const dark = value.mode === 'dark' || value.mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.appearance = value.mode;
  root.dataset.previewBackground = value.previewBackground;
  root.style.setProperty('--accent', value.accent);
  root.style.setProperty('--accent-text', readableAccent(value.accent, dark));
  root.style.setProperty('--on-accent', contrast(value.accent, '#ffffff') >= contrast(value.accent, '#000000') ? '#ffffff' : '#000000');
  window.dispatchEvent(new Event('prism-appearance-change'));
}
// Apply before React mounts, including a saved system preference.
applyAppearance(readAppearance());

export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  useLayoutEffect(() => {
    applyAppearance(appearance);
    try { localStorage.setItem(storageKey, JSON.stringify(appearance)); } catch { /* Still works without storage. */ }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => { if (appearance.mode === 'system') applyAppearance(appearance); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [appearance]);
  return { appearance, setAppearance };
}

export function AppearanceSettings({ appearance, setAppearance }: ReturnType<typeof useAppearance>) {
  const custom = !accentPresets.some(p => p.color === appearance.accent);
  return <section className="appearance-settings" aria-label="外观设置">
    <div className="appearance-heading"><h3>外观</h3><span>即时生效 · 自动保存</span></div>
    <div className="appearance-row"><span>显示模式</span><div className="theme-modes" role="group" aria-label="显示模式">
      {modes.map(({ value, label, icon: Icon }) => <button key={value} type="button" aria-pressed={appearance.mode === value}
        onClick={() => setAppearance(old => ({ ...old, mode: value }))}><Icon size={15}/>{label}</button>)}
    </div></div>
    <div className="appearance-row"><span>主题颜色</span><div className="accent-options" role="group" aria-label="主题颜色">
      {accentPresets.map(p => <button key={p.color} type="button" className="accent-swatch" title={p.name}
        aria-label={`${p.name}主题`} aria-pressed={appearance.accent === p.color}
        style={{ '--swatch': p.color } as React.CSSProperties}
        onClick={() => setAppearance(old => ({ ...old, accent: p.color }))}>
        {appearance.accent === p.color && <Check size={16}/>}</button>)}
      <label className={`custom-accent ${custom ? 'active' : ''}`}><input type="color" aria-label="自定义主题颜色" value={appearance.accent}
        onChange={e => { const accent = e.target.value; if (validColor(accent)) setAppearance(old => ({ ...old, accent: accent.toLowerCase() })); }}/>
        自定义</label>
    </div></div>
    <div className="appearance-row"><span>预览背景</span><div className="theme-modes" role="group" aria-label="预览背景">
      <button type="button" aria-pressed={appearance.previewBackground === 'solid'}
        onClick={() => setAppearance(old => ({ ...old, previewBackground: 'solid' }))}><Square size={14}/>纯色</button>
      <button type="button" aria-pressed={appearance.previewBackground === 'checker'}
        onClick={() => setAppearance(old => ({ ...old, previewBackground: 'checker' }))}><Grid2X2 size={14}/>透明网格</button>
    </div></div>
    <p>主题色用于选中标记与主要操作。透明网格可辅助检查图片透明区域，图片颜色保持不变。</p>
  </section>;
}
