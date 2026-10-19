# MLX Studio icon and logo

- `resources/logo.svg` — master icon (1024 px canvas, macOS grid: 824 px rounded
  square). The MLX emblem — Material Design Icons "alpha-x" box (Pictogrammers,
  Apache 2.0), the same shape as mlx.app's `components/Logo.tsx` — filled with the
  MLX brand gradient (ink `#1D1D1F` to orange `#F08A00`) on an aluminum body.
- `resources/icon.png` — 1024 px render used by electron-builder (it makes the .icns).
- `src/renderer/public/{favicon-16,favicon-32,app-icon-64}.png` — derived by
  `npm run icons` (`generate-icons.js`).
- `build/dmg-background.svg` → `dmg-background.png` (760×460) and `@2x`.
- In the app, the sidebar draws the emblem as vector art (`components/brand/Logo.tsx`),
  so it follows light and dark (white to orange in dark).

Regenerate after editing the SVGs:

```bash
cd panel
node -e "require('sharp')('resources/logo.svg',{density:72}).resize(1024,1024).png().toFile('resources/icon.png')"
npm run icons
node -e "const s=require('sharp');s('build/dmg-background.svg',{density:72}).resize(760,460).png().toFile('build/dmg-background.png');s('build/dmg-background.svg',{density:144}).resize(1520,920).png().toFile('build/dmg-background@2x.png')"
```

The "vMLX" logo and name are not used as MLX Studio branding; vMLX is credited in
About, Preferences and the README.
