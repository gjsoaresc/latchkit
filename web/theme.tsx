import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from './components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from './components/ui/dropdown-menu.js';

type Theme = 'light' | 'dark' | 'system';
const key = 'latchkit-theme';
const valid = (value: unknown): value is Theme =>
  value === 'light' || value === 'dark' || value === 'system';
function preference(): Theme {
  try {
    const saved = localStorage.getItem(key);
    return valid(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}
function apply(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = theme;
}
// Apply before React's first render. No inline scripts or relaxed CSP are needed.
apply(preference());

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(preference);
  useEffect(() => {
    apply(theme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => apply(theme);
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setTheme(preference());
    };
    media.addEventListener('change', update);
    window.addEventListener('storage', sync);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('storage', sync);
    };
  }, [theme]);
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label={`Theme: ${theme}`}>
          <Icon aria-hidden="true" />
          <span className="capitalize">{theme}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Color theme">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (!valid(value)) return;
            setTheme(value);
            apply(value);
            try {
              localStorage.setItem(key, value);
            } catch {
              /* In-memory choice still works. */
            }
          }}
        >
          {(['light', 'dark', 'system'] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {value === 'system' ? 'System' : value === 'dark' ? 'Dark' : 'Light'}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
