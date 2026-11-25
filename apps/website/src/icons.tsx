import React from 'react';

export type IconName =
  | 'arrow'
  | 'arrow-up-right'
  | 'copy'
  | 'check'
  | 'menu'
  | 'close'
  | 'box'
  | 'database'
  | 'layers'
  | 'globe'
  | 'shield'
  | 'activity'
  | 'bell'
  | 'terminal'
  | 'git'
  | 'hard-drive'
  | 'key'
  | 'server'
  | 'github'
  | 'chevron';

const ICON_PATHS: Record<IconName, string> = {
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  'arrow-up-right': 'M7 17 17 7M9 7h8v8',
  copy: 'M9 9h10v10H9V9ZM15 5V4H4v11h1',
  check: 'm5 12 4.5 4.5L19 7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'm6 6 12 12M6 18 18 6',
  box: 'm12 3 8.5 4.75v8.5L12 21l-8.5-4.75v-8.5L12 3Zm0 9.25 8.5-4.5M12 12.25 3.5 7.75M12 12.25V21',
  database:
    'M20 6c0 2-3.58 3.5-8 3.5S4 8 4 6s3.58-3.5 8-3.5S20 4 20 6Zm0 0v12c0 2-3.58 3.5-8 3.5S4 20 4 18V6m0 6c0 2 3.58 3.5 8 3.5s8-1.5 8-3.5',
  layers: 'm12 3 9 4.5-9 4.5-9-4.5L12 3Zm-9 9 9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-8.5-9h17M12 3a13.5 13.5 0 0 1 3.5 9A13.5 13.5 0 0 1 12 21a13.5 13.5 0 0 1-3.5-9A13.5 13.5 0 0 1 12 3Z',
  shield: 'M12 3 4.5 6.2v5.3c0 4.6 3.1 8.6 7.5 9.8 4.4-1.2 7.5-5.2 7.5-9.8V6.2L12 3Zm-2.7 9.2 1.9 1.9 3.8-4.1',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  bell: 'M18 15H6c1.2-1.2 1.8-2.7 1.8-4.5a4.2 4.2 0 1 1 8.4 0c0 1.8.6 3.3 1.8 4.5Zm-8.2 3a2.4 2.4 0 0 0 4.4 0',
  terminal: 'm4 6 6 6-6 6m8 0h8',
  git: 'M6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6 9v10m0-6c0-2 1.5-3 3.5-3H14a4 4 0 0 1 4 4v1',
  'hard-drive':
    'M4 14h16v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Zm0 0 2.2-8.2A2 2 0 0 1 8.1 4h7.8a2 2 0 0 1 1.9 1.8L20 14m-4 3.5h.01M12.5 17.5h.01',
  key: 'M14.5 10.5a4.5 4.5 0 1 0-4.2 4.48L10 15v2h2v2h2v-2.2l1.2-1.2a4.5 4.5 0 0 0-.7-5.1ZM15 8.5h.01',
  server:
    'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v4A1.5 1.5 0 0 1 18.5 11h-13A1.5 1.5 0 0 1 4 9.5v-4Zm0 9A1.5 1.5 0 0 1 5.5 13h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-4Zm3.5-7h.01M7.5 16.5h.01',
  github:
    'M9 19c-4 1-4-2-6-2m12 5v-4a3 3 0 0 0-1-2c4 0 7-2 7-6a5 5 0 0 0-2-4 5 5 0 0 0 0-4s-2-1-5 2a15 15 0 0 0-5 0C6 1 4 2 4 2a5 5 0 0 0 0 4 5 5 0 0 0-2 4c0 4 3 6 7 6a3 3 0 0 0-1 2v4',
  chevron: 'm9 5 7 7-7 7',
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function ServusMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 501 501"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M300.555 0.783691C411.012 0.783691 500.555 90.3268 500.555 200.784C500.555 311.241 411.012 400.784 300.555 400.784H100.555L129.844 371.494C175.119 326.219 236.526 300.784 300.555 300.784C355.783 300.784 400.555 256.012 400.555 200.784C400.555 145.555 355.783 100.784 300.555 100.784H200.555C145.326 100.784 100.555 145.555 100.555 200.784V400.784L0.554688 500.784V200.784C0.554688 90.3268 90.0977 0.783691 200.555 0.783691H300.555Z"
        fill="currentColor"
      />
    </svg>
  );
}
