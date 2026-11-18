import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Long-lived vendor chunks: app releases then leave these cached. Only
// packages the first screen already imports belong here — a lazily imported
// library (pdfjs, mammoth, defuddle, turndown) placed in one of these groups
// would be pulled into the initial load.
const VENDOR_GROUPS: [string, RegExp][] = [
  ['vendor-react', /^(react|react-dom|scheduler|use-sync-external-store|zustand)$/],
  ['vendor-flow', /^(@xyflow\/|d3-|classcat$)/],
  ['vendor-katex', /^katex$/],
  ['vendor-markdown', /^(react-markdown|remark-|rehype-|micromark|mdast-|hast|unist-|unified$|vfile|lowlight$|highlight\.js$|parse5$|entities$|property-information$|space-separated-tokens$|comma-separated-tokens$|html-void-elements$|html-url-attributes$|web-namespaces$|zwitch$|bail$|trough$|devlop$|ccount$|character-|decode-named-character-reference$|estree-util-|style-to-|inline-style-parser$|markdown-table$|longest-streak$|trim-lines$|is-plain-obj$|extend$|escape-string-regexp$)/],
]

function vendorChunk(id: string): string | undefined {
  const match = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
  if (!match) return undefined
  return VENDOR_GROUPS.find(([, pattern]) => pattern.test(match[1]))?.[0]
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // the app chunk is one canvas-centric module graph; split it on routes, not size
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
})
