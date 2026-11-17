// web/src/theme/index.ts (P3; CONTRACTS §12.2.1, §12.2.3).
// Global styles in cascade order: tokens, then the bundled Source Serif 4 (variable; upright and italic, OFL,
// font-display: swap, shipped into dist/web/assets, no network fetch), then page base styles.
import './tokens.css'
import '@fontsource-variable/source-serif-4/wght.css'
import '@fontsource-variable/source-serif-4/wght-italic.css'
import './base.css'
