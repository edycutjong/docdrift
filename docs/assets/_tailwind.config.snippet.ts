/* Optional. Copy this into your tailwind.config.ts to use the design tokens as Tailwind utilities.
   Requires _tokens.css to be imported globally (e.g., in app/globals.css). */

import type { Config } from 'tailwindcss';

const designSystemTheme: Partial<Config['theme']> = {
  extend: {
    colors: {
      primary: 'var(--primary)',
      accent: 'var(--accent)',
      'primary-glow': 'var(--primary-glow)',
      'accent-glow': 'var(--accent-glow)',
      'bg-base': 'var(--bg-base)',
      'bg-elevated': 'var(--bg-elevated)',
      'bg-overlay': 'var(--bg-overlay)',
      'text-hi': 'var(--text-hi)',
      'text-mid': 'var(--text-mid)',
      'text-low': 'var(--text-low)',
      'border-subtle': 'var(--border-subtle)',
      'border-default': 'var(--border-default)',
      success: 'var(--color-success)',
      warning: 'var(--color-warning)',
      error: 'var(--color-error)',
      info: 'var(--color-info)',
    },
    fontFamily: {
      display: ['var(--font-font-display)'],
      sans: ['var(--font-ui)'],
      mono: ['var(--font-mono)'],
    },
    fontSize: {
      'xs': 'var(--text-xs)',
      'sm': 'var(--text-sm)',
      'base': 'var(--text-base)',
      'lg': 'var(--text-lg)',
      'xl': 'var(--text-xl)',
      '2xl': 'var(--text-2xl)',
      '3xl': 'var(--text-3xl)',
      '4xl': 'var(--text-4xl)',
      '5xl': 'var(--text-5xl)',
    },
    borderRadius: {
      'sm': 'var(--radius-8)',
      'DEFAULT': 'var(--radius-12)',
      'md': 'var(--radius-16)',
      'lg': 'var(--radius-20)',
      'xl': 'var(--radius-24)',
      '2xl': 'var(--radius-32)',
      'full': 'var(--radius-full)',
    },
    boxShadow: {
      'sm': 'var(--shadow-sm)',
      'DEFAULT': 'var(--shadow-md)',
      'lg': 'var(--shadow-lg)',
      'glow': 'var(--shadow-glow)',
    },
    transitionDuration: {
      'fast': '150ms',
      'normal': '250ms',
      'slow': '500ms',
    },
    zIndex: {
      'base': '0', 'dropdown': '100', 'sticky': '200',
      'modal': '300', 'popover': '400', 'toast': '500',
      'overlay': '999',
    },
  },
};

export default designSystemTheme;

// In tailwind.config.ts:
//   import designSystemTheme from './path/to/_tailwind.config.snippet';
//   export default { theme: designSystemTheme, ... } satisfies Config;
